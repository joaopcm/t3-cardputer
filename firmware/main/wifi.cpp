#include "wifi.h"

#include <algorithm>
#include <cstring>

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
#include "t3/wifi_station.h"

namespace {

constexpr char TAG[] = "wifi";

// receipt: docs/receipts/2026-10-21-firmware-network.md "wifi"
constexpr UBaseType_t kRawQueueDepth = 16;

struct Raw {
    bool ip;
    int32_t id;
    int32_t reason;
};

QueueHandle_t rawQueue;

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

class EspWifi : public t3::WifiDriver {
public:
    std::optional<std::string> startScan() override
    {
        wifi_scan_config_t config = {};
        if (const esp_err_t err = esp_wifi_scan_start(&config, false); err != ESP_OK) {
            return esp_err_to_name(err);
        }
        return std::nullopt;
    }

    std::optional<std::string> connect(const t3::WifiJoin &cred) override
    {
        wifi_config_t config = {};
        std::memcpy(config.sta.ssid, cred.ssid.data(), std::min(cred.ssid.size(), sizeof(config.sta.ssid)));
        std::memcpy(config.sta.password, cred.password.data(), std::min(cred.password.size(), sizeof(config.sta.password) - 1));
        config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
        config.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
        esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &config);
        if (err == ESP_OK) {
            err = esp_wifi_connect();
        }
        std::memset(&config, 0, sizeof(config));
        if (err != ESP_OK) {
            return esp_err_to_name(err);
        }
        return std::nullopt;
    }

    void disconnect() override { esp_wifi_disconnect(); }

    t3::SavedWifi saved() override
    {
        t3::SavedWifi saved;
        for (settings::WifiCred &cred : settings::wifi()) {
            saved.creds.push_back(t3::WifiJoin{std::move(cred.ssid), std::move(cred.password)});
        }
        return saved;
    }
};

EspWifi driver;
t3::WifiStation station(driver);

struct Scan {
    std::vector<t3::WifiNet> nets;
    bool hidden = false;
};

Scan scanResults()
{
    uint16_t count = 0;
    esp_wifi_scan_get_ap_num(&count);
    std::vector<wifi_ap_record_t> records(count);
    if (count > 0 && esp_wifi_scan_get_ap_records(&count, records.data()) != ESP_OK) {
        count = 0;
    }
    records.resize(count);
    Scan scan;
    std::vector<t3::WifiNet> &nets = scan.nets;
    for (const wifi_ap_record_t &record : records) {
        const std::string ssid(reinterpret_cast<const char *>(record.ssid), strnlen(reinterpret_cast<const char *>(record.ssid), sizeof(record.ssid)));
        if (ssid.empty()) {
            scan.hidden = true;
            continue;
        }
        auto known = std::find_if(nets.begin(), nets.end(), [&](const t3::WifiNet &net) { return net.ssid == ssid; });
        if (known != nets.end()) {
            known->rssi = std::max(known->rssi, static_cast<int>(record.rssi));
            continue;
        }
        nets.push_back(t3::WifiNet{ssid, record.rssi, record.authmode != WIFI_AUTH_OPEN, false});
    }
    std::sort(nets.begin(), nets.end(), [](const t3::WifiNet &a, const t3::WifiNet &b) { return a.rssi > b.rssi; });
    ESP_LOGI(TAG, "scan: %u access points, %u networks%s", static_cast<unsigned>(count), static_cast<unsigned>(nets.size()), scan.hidden ? ", a hidden one" : "");
    return scan;
}

void handle(const Raw &raw, uint32_t nowMs)
{
    if (raw.ip) {
        if (raw.id == IP_EVENT_STA_GOT_IP) {
            station.onGotIp();
        }
        return;
    }
    switch (raw.id) {
    case WIFI_EVENT_SCAN_DONE: {
        Scan scan = scanResults();
        station.onScanDone(std::move(scan.nets), scan.hidden, nowMs);
        return;
    }
    case WIFI_EVENT_STA_DISCONNECTED:
        station.onDisconnected(reasonText(raw.reason), nowMs);
        return;
    default:
        return;
    }
}

void logEvent(const WifiEvent &event)
{
    switch (event.kind) {
    case WifiEvent::Kind::Up:
        ESP_LOGI(TAG, "up on %s", event.text.c_str());
        return;
    case WifiEvent::Kind::Down:
        ESP_LOGW(TAG, "down: %s", event.text.c_str());
        return;
    case WifiEvent::Kind::Scanned:
        return;
    case WifiEvent::Kind::Joined:
        ESP_LOGI(TAG, "joined %s", event.text.c_str());
        return;
    case WifiEvent::Kind::JoinFailed:
    case WifiEvent::Kind::Status:
        ESP_LOGI(TAG, "%s", event.text.c_str());
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
    station.start(nowMs);
}

void wifi_scan()
{
    station.scan();
}

void wifi_join(const std::string &ssid, const std::string &password, uint32_t nowMs)
{
    station.join(t3::WifiJoin{ssid, password}, nowMs);
}

std::optional<WifiEvent> wifi_poll(uint32_t nowMs)
{
    Raw raw;
    while (!station.hasEvent() && xQueueReceive(rawQueue, &raw, 0) == pdTRUE) {
        handle(raw, nowMs);
    }
    std::optional<WifiEvent> event = station.poll(nowMs);
    if (event) {
        logEvent(*event);
    }
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
