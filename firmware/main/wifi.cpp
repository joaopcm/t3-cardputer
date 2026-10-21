#include "wifi.h"

#include <algorithm>
#include <cstring>
#include <deque>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_net_stack.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "lwip/netif.h"
#include "lwip/tcpip.h"
#include "settings.h"

namespace {

constexpr char TAG[] = "wifi";

// receipt: docs/receipts/2026-10-21-firmware-network.md "wifi"
constexpr uint32_t kWifiJoinWaitMs = 20000;
constexpr uint32_t kWifiRetryMs = 10000;
constexpr UBaseType_t kRawQueueDepth = 16;

struct Raw {
    bool ip;
    int32_t id;
    int32_t reason;
};

enum class State { Idle, Scanning, Connecting, Leaving, Up, Waiting };

QueueHandle_t rawQueue;
std::deque<WifiEvent> pending;
State state = State::Idle;
bool autoWanted = false;
bool listWanted = false;
bool scanAfterConnect = false;
uint32_t deadlineMs = 0;
settings::WifiCred target;
std::optional<settings::WifiCred> join;
bool joining = false;

bool reached(uint32_t nowMs, uint32_t atMs)
{
    return static_cast<int32_t>(nowMs - atMs) >= 0;
}

void emit(WifiEvent::Kind kind, std::string text = {}, std::vector<t3::WifiNet> nets = {})
{
    pending.push_back(WifiEvent{kind, std::move(text), std::move(nets)});
}

void onSystemEvent(void *, esp_event_base_t base, int32_t id, void *data)
{
    Raw raw{base == IP_EVENT, id, 0};
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        raw.reason = static_cast<const wifi_event_sta_disconnected_t *>(data)->reason;
    }
    if (xQueueSend(rawQueue, &raw, 0) != pdTRUE) {
        ESP_LOGE(TAG, "wifi_raw_queue=%u, event %ld dropped, queue full", static_cast<unsigned>(kRawQueueDepth), static_cast<long>(id));
    }
}

std::string reasonText(int reason)
{
    switch (reason) {
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_MIC_FAILURE:
        return "wrong password (reason " + std::to_string(reason) + ")";
    case WIFI_REASON_NO_AP_FOUND:
        return "network not found (reason " + std::to_string(reason) + ")";
    default:
        return "reason " + std::to_string(reason);
    }
}

void startScan()
{
    if (state == State::Connecting || state == State::Leaving) {
        scanAfterConnect = true;
        return;
    }
    if (state == State::Scanning) {
        return;
    }
    wifi_scan_config_t config = {};
    const esp_err_t err = esp_wifi_scan_start(&config, false);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "scan start failed: %s", esp_err_to_name(err));
        emit(WifiEvent::Kind::Status, std::string("wifi: scan failed: ") + esp_err_to_name(err));
        if (listWanted) {
            listWanted = false;
            emit(WifiEvent::Kind::Scanned);
        }
        return;
    }
    if (state != State::Up) {
        state = State::Scanning;
    }
}

void connect(const settings::WifiCred &cred, uint32_t nowMs)
{
    wifi_config_t config = {};
    std::memcpy(config.sta.ssid, cred.ssid.data(), std::min(cred.ssid.size(), sizeof(config.sta.ssid)));
    std::memcpy(config.sta.password, cred.password.data(), std::min(cred.password.size(), sizeof(config.sta.password) - 1));
    config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    config.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    target = cred;
    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &config);
    if (err == ESP_OK) {
        err = esp_wifi_connect();
    }
    std::memset(&config, 0, sizeof(config));
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "connect to %s failed to start: %s", cred.ssid.c_str(), esp_err_to_name(err));
        state = State::Waiting;
        deadlineMs = nowMs + kWifiRetryMs;
        return;
    }
    ESP_LOGI(TAG, "joining %s", cred.ssid.c_str());
    state = State::Connecting;
    deadlineMs = nowMs + kWifiJoinWaitMs;
    emit(WifiEvent::Kind::Status, "wifi: joining " + cred.ssid);
}

std::vector<t3::WifiNet> scanResults()
{
    uint16_t count = 0;
    esp_wifi_scan_get_ap_num(&count);
    std::vector<wifi_ap_record_t> records(count);
    if (count > 0 && esp_wifi_scan_get_ap_records(&count, records.data()) != ESP_OK) {
        count = 0;
    }
    records.resize(count);
    const std::vector<settings::WifiCred> saved = settings::wifi();
    std::vector<t3::WifiNet> nets;
    for (const wifi_ap_record_t &record : records) {
        const std::string ssid(reinterpret_cast<const char *>(record.ssid), strnlen(reinterpret_cast<const char *>(record.ssid), sizeof(record.ssid)));
        if (ssid.empty()) {
            continue;
        }
        auto known = std::find_if(nets.begin(), nets.end(), [&](const t3::WifiNet &net) { return net.ssid == ssid; });
        if (known != nets.end()) {
            known->rssi = std::max(known->rssi, static_cast<int>(record.rssi));
            continue;
        }
        const bool isSaved = std::any_of(saved.begin(), saved.end(), [&](const settings::WifiCred &cred) { return cred.ssid == ssid; });
        nets.push_back(t3::WifiNet{ssid, record.rssi, record.authmode != WIFI_AUTH_OPEN, isSaved});
    }
    std::sort(nets.begin(), nets.end(), [](const t3::WifiNet &a, const t3::WifiNet &b) { return a.rssi > b.rssi; });
    ESP_LOGI(TAG, "scan: %u access points, %u networks", static_cast<unsigned>(count), static_cast<unsigned>(nets.size()));
    return nets;
}

void connectStrongestSaved(const std::vector<t3::WifiNet> &nets, uint32_t nowMs)
{
    const std::vector<settings::WifiCred> saved = settings::wifi();
    for (const t3::WifiNet &net : nets) {
        for (const settings::WifiCred &cred : saved) {
            if (cred.ssid == net.ssid) {
                connect(cred, nowMs);
                return;
            }
        }
    }
    state = State::Waiting;
    deadlineMs = nowMs + kWifiRetryMs;
    emit(WifiEvent::Kind::Status, saved.empty() ? "wifi: no saved network, Fn+S adds one" : "wifi: no saved network in range");
}

void startJoin(uint32_t nowMs)
{
    const settings::WifiCred cred = *join;
    join.reset();
    joining = true;
    connect(cred, nowMs);
}

void failed(std::string why, uint32_t nowMs)
{
    ESP_LOGW(TAG, "%s: %s", target.ssid.c_str(), why.c_str());
    state = State::Waiting;
    if (joining) {
        joining = false;
        deadlineMs = nowMs;
        emit(WifiEvent::Kind::JoinFailed, "wifi: " + target.ssid + " failed, " + why);
        return;
    }
    deadlineMs = nowMs + kWifiRetryMs;
    emit(WifiEvent::Kind::Status, "wifi: " + target.ssid + " failed, " + why);
}

void afterConnectAttempt()
{
    if (scanAfterConnect) {
        scanAfterConnect = false;
        startScan();
    }
}

void handle(const Raw &raw, uint32_t nowMs)
{
    if (raw.ip) {
        if (raw.id == IP_EVENT_STA_GOT_IP && state == State::Connecting) {
            ESP_LOGI(TAG, "up on %s", target.ssid.c_str());
            state = State::Up;
            if (joining) {
                joining = false;
                emit(WifiEvent::Kind::Joined, target.ssid);
            }
            emit(WifiEvent::Kind::Up, target.ssid);
            afterConnectAttempt();
        }
        return;
    }
    switch (raw.id) {
    case WIFI_EVENT_SCAN_DONE: {
        std::vector<t3::WifiNet> nets = scanResults();
        const bool searching = state == State::Scanning;
        if (state == State::Scanning) {
            state = State::Idle;
        }
        if (listWanted) {
            listWanted = false;
            emit(WifiEvent::Kind::Scanned, {}, nets);
        }
        if (state == State::Idle && join) {
            startJoin(nowMs);
        } else if (searching && autoWanted) {
            connectStrongestSaved(nets, nowMs);
        }
        return;
    }
    case WIFI_EVENT_STA_DISCONNECTED:
        if (state == State::Leaving) {
            state = State::Idle;
            startJoin(nowMs);
        } else if (state == State::Connecting) {
            failed(reasonText(raw.reason), nowMs);
            afterConnectAttempt();
        } else if (state == State::Up) {
            ESP_LOGW(TAG, "down: %s", reasonText(raw.reason).c_str());
            emit(WifiEvent::Kind::Down, reasonText(raw.reason));
            state = State::Idle;
            if (autoWanted) {
                startScan();
            }
        }
        return;
    default:
        return;
    }
}

}

bool wifi_init()
{
    rawQueue = xQueueCreate(kRawQueueDepth, sizeof(Raw));
    if (rawQueue == nullptr) {
        ESP_LOGE(TAG, "wifi_raw_queue=%u alloc failed", static_cast<unsigned>(kRawQueueDepth));
        return false;
    }
    esp_err_t err = esp_netif_init();
    if (err == ESP_OK) {
        err = esp_event_loop_create_default();
    }
    if (err == ESP_OK && esp_netif_create_default_wifi_sta() == nullptr) {
        err = ESP_FAIL;
    }
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    if (err == ESP_OK) {
        err = esp_wifi_init(&config);
    }
    if (err == ESP_OK) {
        err = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, onSystemEvent, nullptr, nullptr);
    }
    if (err == ESP_OK) {
        err = esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, onSystemEvent, nullptr, nullptr);
    }
    if (err == ESP_OK) {
        err = esp_wifi_set_storage(WIFI_STORAGE_RAM);
    }
    if (err == ESP_OK) {
        err = esp_wifi_set_mode(WIFI_MODE_STA);
    }
    if (err == ESP_OK) {
        err = esp_wifi_start();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "init failed: %s", esp_err_to_name(err));
        return false;
    }
    return true;
}

void wifi_start(uint32_t nowMs)
{
    autoWanted = true;
    if (state == State::Idle || state == State::Waiting) {
        deadlineMs = nowMs;
        state = State::Waiting;
    }
}

void wifi_scan()
{
    listWanted = true;
    startScan();
}

void wifi_join(const std::string &ssid, const std::string &password, uint32_t nowMs)
{
    autoWanted = true;
    join = settings::WifiCred{ssid, password};
    switch (state) {
    case State::Up:
        emit(WifiEvent::Kind::Down, "joining " + ssid);
        [[fallthrough]];
    case State::Connecting:
        state = State::Leaving;
        deadlineMs = nowMs + kWifiJoinWaitMs;
        esp_wifi_disconnect();
        return;
    case State::Scanning:
    case State::Leaving:
        return;
    case State::Idle:
    case State::Waiting:
        startJoin(nowMs);
        return;
    }
}

std::optional<WifiEvent> wifi_poll(uint32_t nowMs)
{
    Raw raw;
    while (pending.empty() && xQueueReceive(rawQueue, &raw, 0) == pdTRUE) {
        handle(raw, nowMs);
    }
    if (pending.empty()) {
        if (state == State::Connecting && reached(nowMs, deadlineMs)) {
            esp_wifi_disconnect();
            failed("no ip within kWifiJoinWaitMs=" + std::to_string(kWifiJoinWaitMs), nowMs);
            afterConnectAttempt();
        } else if (state == State::Leaving && reached(nowMs, deadlineMs)) {
            state = State::Idle;
            startJoin(nowMs);
        } else if (state == State::Waiting && autoWanted && reached(nowMs, deadlineMs)) {
            state = State::Idle;
            startScan();
        }
    }
    if (pending.empty()) {
        return std::nullopt;
    }
    WifiEvent event = std::move(pending.front());
    pending.pop_front();
    return event;
}

namespace {

netif_linkoutput_fn realOutput = nullptr;

err_t swallowFrame(struct netif *, struct pbuf *)
{
    return ERR_OK;
}

void startBlackHole(void *netif)
{
    struct netif *sta = static_cast<struct netif *>(netif);
    if (realOutput == nullptr) {
        realOutput = sta->linkoutput;
        sta->linkoutput = swallowFrame;
    }
}

void endBlackHole(void *netif)
{
    if (realOutput != nullptr) {
        static_cast<struct netif *>(netif)->linkoutput = realOutput;
        realOutput = nullptr;
    }
}

}

void wifi_debug_leave_ap()
{
    esp_wifi_disconnect();
}

void wifi_debug_black_hole(bool on)
{
    // why: a netif that swallows every outgoing frame keeps the association and the socket but delivers nothing, like an access point that went out of range before the beacon timeout
    if (esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF")) {
        tcpip_callback(on ? startBlackHole : endBlackHole, esp_netif_get_netif_impl(sta));
    }
}
