#include "transport.h"

#include <atomic>
#include <algorithm>
#include <cstring>

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

namespace {

constexpr char TAG[] = "transport";

// receipts: docs/receipts/2026-10-21-firmware-network.md sections "transport", "connect" and "stacks"
constexpr int kWsChunkBytes = 1024;
constexpr int kWsTaskStackBytes = 6144;
constexpr int kNetworkTimeoutMs = 10000;
constexpr TickType_t kSendWaitTicks = pdMS_TO_TICKS(5000);
constexpr int kSlots = 2;
constexpr UBaseType_t kInboxDepth = 8;
constexpr int kPairTimeoutMs = 10000;
constexpr uint32_t kPairTaskStackBytes = 6144;
constexpr size_t kPairReplyMax = 1024;
constexpr size_t kReasonMax = 48;
// receipt: RFC 6455 section 7.4.1, 1006 is the code for a close with no close frame and 1005 for a close frame with no status
constexpr int kAbnormalClose = 1006;
constexpr int kNoStatusClose = 1005;

struct Item {
    TransportEvent::Kind kind;
    uint32_t gen;
    int32_t code;
    int8_t slot;
    uint32_t bytes;
    char reason[kReasonMax];
};

enum class Drop : uint8_t { None, Oversize, NoSlot, InboxFull, Fragmented };

esp_websocket_client_handle_t client;
QueueHandle_t inbox;
TaskHandle_t mainTask;
size_t maxFrame = 0;
char *slots[kSlots];
std::atomic<bool> slotBusy[kSlots];
int mainSlot = -1;
std::atomic<uint32_t> generation{0};

uint32_t taskGen = 0;
bool closePosted = false;
int filling = -1;
bool skipping = false;
size_t filled = 0;

std::atomic<uint32_t> droppedFrames{0};
std::atomic<uint32_t> droppedBytes{0};
std::atomic<Drop> dropWhy{Drop::None};
uint32_t droppedSeen = 0;

std::string pairUrl;
std::string closeReason;

void drop(Drop why, int bytes)
{
    dropWhy = why;
    droppedBytes = static_cast<uint32_t>(bytes);
    droppedFrames.fetch_add(1);
}

bool post(Item &item)
{
    item.gen = taskGen;
    if (xQueueSend(inbox, &item, 0) != pdTRUE) {
        return false;
    }
    xTaskNotifyGive(mainTask);
    return true;
}

void abandonFill()
{
    if (filling >= 0) {
        slotBusy[filling] = false;
        filling = -1;
    }
    skipping = false;
}

std::string failureReason(const esp_websocket_event_data_t &event)
{
    const esp_websocket_error_codes_t &error = event.error_handle;
    if (error.error_type == WEBSOCKET_ERROR_TYPE_PONG_TIMEOUT) {
        return "no pong from relay";
    }
    if (error.esp_ws_handshake_status_code > 0 && error.esp_ws_handshake_status_code != 101) {
        return "upgrade got http " + std::to_string(error.esp_ws_handshake_status_code);
    }
    if (error.esp_tls_last_esp_err != ESP_OK) {
        return esp_err_to_name(error.esp_tls_last_esp_err);
    }
    if (error.esp_transport_sock_errno != 0) {
        return "socket errno " + std::to_string(error.esp_transport_sock_errno);
    }
    return {};
}

void postClose(int code, std::string_view reason)
{
    abandonFill();
    if (closePosted) {
        return;
    }
    closePosted = true;
    Item item{TransportEvent::Kind::Close, 0, code, -1, 0, {}};
    const size_t bytes = std::min(reason.size(), kReasonMax);
    std::memcpy(item.reason, reason.data(), bytes);
    item.bytes = static_cast<uint32_t>(bytes);
    if (!post(item)) {
        ESP_LOGE(TAG, "rx_inbox_depth=%u, close %d dropped, queue full", static_cast<unsigned>(kInboxDepth), code);
    }
}

void onText(const esp_websocket_event_data_t &event)
{
    if (event.payload_offset == 0) {
        abandonFill();
        if (!event.fin || event.op_code == WS_TRANSPORT_OPCODES_CONT) {
            drop(Drop::Fragmented, event.payload_len);
            skipping = true;
        } else if (static_cast<size_t>(event.payload_len) > maxFrame) {
            drop(Drop::Oversize, event.payload_len);
            skipping = true;
        } else {
            for (int i = 0; i < kSlots && filling < 0; ++i) {
                bool expected = false;
                if (slotBusy[i].compare_exchange_strong(expected, true)) {
                    filling = i;
                }
            }
            if (filling < 0) {
                drop(Drop::NoSlot, event.payload_len);
                skipping = true;
            }
            filled = 0;
        }
    }
    if (skipping || filling < 0) {
        return;
    }
    std::memcpy(slots[filling] + filled, event.data_ptr, static_cast<size_t>(event.data_len));
    filled += static_cast<size_t>(event.data_len);
    if (filled < static_cast<size_t>(event.payload_len)) {
        return;
    }
    Item item{TransportEvent::Kind::Text, 0, 0, static_cast<int8_t>(filling), static_cast<uint32_t>(filled), {}};
    if (!post(item)) {
        drop(Drop::InboxFull, static_cast<int>(filled));
        slotBusy[filling] = false;
    }
    filling = -1;
}

void onWsEvent(void *, esp_event_base_t, int32_t id, void *data)
{
    const auto &event = *static_cast<const esp_websocket_event_data_t *>(data);
    switch (id) {
    case WEBSOCKET_EVENT_BEGIN:
        taskGen = generation.load();
        closePosted = false;
        abandonFill();
        return;
    case WEBSOCKET_EVENT_CONNECTED: {
        Item item{TransportEvent::Kind::Open, 0, 0, -1, 0, {}};
        if (!post(item)) {
            ESP_LOGE(TAG, "rx_inbox_depth=%u, open dropped, queue full", static_cast<unsigned>(kInboxDepth));
        }
        return;
    }
    case WEBSOCKET_EVENT_DATA:
        if (event.op_code == WS_TRANSPORT_OPCODES_TEXT || event.op_code == WS_TRANSPORT_OPCODES_CONT) {
            onText(event);
        }
        return;
    case WEBSOCKET_EVENT_DISCONNECTED:
        postClose(kAbnormalClose, failureReason(event));
        return;
    case WEBSOCKET_EVENT_CLOSED:
        postClose(event.close_status_code == 0 ? kNoStatusClose : event.close_status_code, {});
        return;
    case WEBSOCKET_EVENT_FINISH:
        ESP_LOGI(TAG, "ws_task_stack_free_min=%u of %u", static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
                 static_cast<unsigned>(kWsTaskStackBytes));
        postClose(kAbnormalClose, {});
        return;
    default:
        return;
    }
}

std::string httpsBase(std::string url)
{
    if (url.rfind("wss://", 0) == 0) {
        return "https://" + url.substr(6);
    }
    if (url.rfind("ws://", 0) == 0) {
        return "http://" + url.substr(5);
    }
    return url;
}

struct PairJob {
    std::string body;
    PairDone done;
    std::atomic<bool> finished{false};
    bool running = false;
};

PairJob pairJob;

void pairTask(void *)
{
    PairDone &done = pairJob.done;
    esp_http_client_config_t config = {};
    config.url = pairUrl.c_str();
    config.method = HTTP_METHOD_POST;
    config.timeout_ms = kPairTimeoutMs;
    config.crt_bundle_attach = esp_crt_bundle_attach;
    esp_http_client_handle_t http = esp_http_client_init(&config);
    esp_err_t err = http == nullptr ? ESP_ERR_NO_MEM : esp_http_client_set_header(http, "Content-Type", "application/json");
    if (err == ESP_OK) {
        err = esp_http_client_open(http, static_cast<int>(pairJob.body.size()));
    }
    if (err == ESP_OK && esp_http_client_write(http, pairJob.body.data(), static_cast<int>(pairJob.body.size())) != static_cast<int>(pairJob.body.size())) {
        err = ESP_ERR_HTTP_WRITE_DATA;
    }
    if (err == ESP_OK && esp_http_client_fetch_headers(http) < 0) {
        err = ESP_ERR_HTTP_FETCH_HEADER;
    }
    if (err == ESP_OK) {
        done.status = esp_http_client_get_status_code(http);
        done.body.resize(kPairReplyMax + 1);
        int got = 0;
        for (;;) {
            const int n = esp_http_client_read(http, done.body.data() + got, static_cast<int>(done.body.size()) - got);
            if (n <= 0) {
                break;
            }
            got += n;
            if (static_cast<size_t>(got) > kPairReplyMax) {
                break;
            }
        }
        if (static_cast<size_t>(got) > kPairReplyMax) {
            done.error = "pair_reply_max=" + std::to_string(kPairReplyMax) + ", reply needed more";
        }
        done.body.resize(static_cast<size_t>(std::max(got, 0)));
    } else {
        done.error = std::string("pair: ") + esp_err_to_name(err);
    }
    if (http != nullptr) {
        esp_http_client_cleanup(http);
    }
    std::fill(pairJob.body.begin(), pairJob.body.end(), '\0');
    pairJob.body.clear();
    ESP_LOGI(TAG, "pair_task_stack_free_min=%u of %u", static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
             static_cast<unsigned>(kPairTaskStackBytes));
    pairJob.finished = true;
    vTaskDelete(nullptr);
}

}

bool transport_init(const std::string &relayUrl, size_t maxFrameBytes)
{
    maxFrame = maxFrameBytes;
    mainTask = xTaskGetCurrentTaskHandle();
    inbox = xQueueCreate(kInboxDepth, sizeof(Item));
    bool ok = inbox != nullptr;
    for (int i = 0; i < kSlots; ++i) {
        slots[i] = static_cast<char *>(malloc(maxFrameBytes));
        slotBusy[i] = false;
        ok = ok && slots[i] != nullptr;
    }
    if (!ok) {
        ESP_LOGE(TAG, "rx_slots=%d x max_frame_bytes=%u alloc failed", kSlots, static_cast<unsigned>(maxFrameBytes));
        return false;
    }
    pairUrl = httpsBase(relayUrl) + "/v1/pair";
    const std::string deviceUrl = relayUrl + "/v1/device";
    esp_websocket_client_config_t config = {};
    config.uri = deviceUrl.c_str();
    config.crt_bundle_attach = esp_crt_bundle_attach;
    config.disable_auto_reconnect = true;
    config.buffer_size = kWsChunkBytes;
    config.task_stack = kWsTaskStackBytes;
    config.network_timeout_ms = kNetworkTimeoutMs;
    client = esp_websocket_client_init(&config);
    if (client == nullptr || esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY, onWsEvent, nullptr) != ESP_OK) {
        ESP_LOGE(TAG, "websocket client init failed");
        return false;
    }
    esp_log_level_set("websocket_client", ESP_LOG_ERROR);
    return true;
}

bool transport_connect()
{
    esp_websocket_client_stop(client);
    generation.fetch_add(1);
    if (esp_websocket_client_start(client) != ESP_OK) {
        ESP_LOGE(TAG, "websocket start failed");
        return false;
    }
    return true;
}

void transport_close()
{
    esp_websocket_client_stop(client);
    generation.fetch_add(1);
}

std::optional<std::string> transport_send(std::string_view text)
{
    if (!esp_websocket_client_is_connected(client)) {
        return std::string("not connected, ") + std::to_string(text.size()) + " bytes not sent";
    }
    const int sent = esp_websocket_client_send_text(client, text.data(), static_cast<int>(text.size()), kSendWaitTicks);
    if (sent != static_cast<int>(text.size())) {
        return "send failed, " + std::to_string(text.size()) + " bytes not sent";
    }
    return std::nullopt;
}

std::optional<TransportEvent> transport_poll()
{
    if (mainSlot >= 0) {
        slotBusy[mainSlot] = false;
        mainSlot = -1;
    }
    Item item;
    while (xQueueReceive(inbox, &item, 0) == pdTRUE) {
        if (item.gen != generation.load()) {
            if (item.slot >= 0) {
                slotBusy[item.slot] = false;
            }
            continue;
        }
        switch (item.kind) {
        case TransportEvent::Kind::Open:
            return TransportEvent{TransportEvent::Kind::Open, 0, {}};
        case TransportEvent::Kind::Text:
            mainSlot = item.slot;
            return TransportEvent{TransportEvent::Kind::Text, 0, std::string_view(slots[item.slot], item.bytes)};
        case TransportEvent::Kind::Close:
            closeReason = std::string(item.reason, item.bytes);
            return TransportEvent{TransportEvent::Kind::Close, item.code, closeReason};
        }
    }
    return std::nullopt;
}

std::optional<std::string> transport_dropped()
{
    const uint32_t count = droppedFrames.load();
    if (count == droppedSeen) {
        return std::nullopt;
    }
    droppedSeen = count;
    const std::string needed = std::to_string(droppedBytes.load());
    switch (dropWhy.load()) {
    case Drop::Oversize:
        return "max_frame_bytes=" + std::to_string(maxFrame) + ", relay frame needed " + needed;
    case Drop::NoSlot:
        return "rx_slots=" + std::to_string(kSlots) + ", a " + needed + " byte frame needed one more";
    case Drop::InboxFull:
        return "rx_inbox_depth=" + std::to_string(kInboxDepth) + ", a " + needed + " byte frame needed one more";
    case Drop::Fragmented:
        return "fragmented relay frame dropped, " + needed + " bytes";
    case Drop::None:
        break;
    }
    return std::nullopt;
}

void transport_wait(TickType_t ticks)
{
    ulTaskNotifyTake(pdTRUE, ticks);
}

std::optional<std::string> pair_start(std::string body)
{
    if (pairJob.running) {
        return std::string("pairing already running");
    }
    pairJob.body = std::move(body);
    pairJob.done = PairDone{};
    pairJob.finished = false;
    pairJob.running = true;
    if (xTaskCreate(pairTask, "pair", kPairTaskStackBytes, nullptr, tskIDLE_PRIORITY + 2, nullptr) != pdPASS) {
        pairJob.running = false;
        pairJob.body.clear();
        return "pair task stack=" + std::to_string(kPairTaskStackBytes) + ", alloc failed";
    }
    return std::nullopt;
}

std::optional<PairDone> pair_poll()
{
    if (!pairJob.running || !pairJob.finished) {
        return std::nullopt;
    }
    pairJob.running = false;
    return std::move(pairJob.done);
}
