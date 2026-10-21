#include "transport.h"

#include <atomic>
#include <algorithm>
#include <cstring>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "t3/link.h"

namespace {

constexpr char TAG[] = "t3_transport";

// receipts: docs/receipts/2026-10-21-firmware-network.md sections "transport", "connect", "stacks" and "fix round 1"
constexpr int kWsChunkBytes = 1024;
constexpr int kWsTaskStackBytes = 6144;
constexpr int kNetworkTimeoutMs = 10000;
constexpr TickType_t kSendWaitTicks = pdMS_TO_TICKS(5000);
constexpr size_t kRingFrames = 3;
constexpr UBaseType_t kInboxDepth = 16;
constexpr uint32_t kControlTaskStackBytes = 4096;
// why: above the main task (priority 1) so a queued stop or start is never starved by the UI loop, below the websocket task (5) it waits on
constexpr UBaseType_t kControlTaskPriority = 4;
// receipt: docs/receipts/2026-10-21-firmware-network.md "soak", one TLS handshake needs 50332 bytes, x1.2 for fragmentation
constexpr size_t kTlsHeapBytes = 60398;
// receipt: docs/receipts/2026-10-21-firmware-voice.md "heap", waits at most the link's first backoff step and checks 10 times in it; in 12 reconnects after a stalled recording it never had to wait
constexpr uint32_t kTlsHeapWaitMs = t3::kBackoffMinMs;
constexpr TickType_t kTlsHeapPollTicks = pdMS_TO_TICKS(kTlsHeapWaitMs / 10);
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
    uint64_t start;
    uint64_t end;
    uint32_t bytes;
    char reason[kReasonMax];
};

enum class Drop : uint8_t { None, Oversize, RingFull, InboxFull, Fragmented };

esp_websocket_client_handle_t client;
QueueHandle_t inbox;
TaskHandle_t mainTask;
size_t maxFrame = 0;
char *ring;
size_t ringBytes = 0;
std::atomic<uint64_t> ringHead{0};
std::atomic<uint64_t> ringTail{0};
uint64_t mainEnd = 0;
bool mainHolds = false;
std::atomic<uint32_t> generation{0};
std::atomic<uint32_t> wantedGen{0};
uint32_t openGen = 0;
TaskHandle_t controlTask;
uint32_t startGen = 0;

uint32_t taskGen = 0;
// why: esp_websocket_client 1.8.0 dispatches DISCONNECTED from a failed send on the sending task and FINISH on its own task, see the receipt "transport"
std::atomic<bool> closePosted{false};
bool opened = false;
std::atomic<uint32_t> startLargest{UINT32_MAX};
std::string errorReason;
bool filling = false;
uint64_t fillStart = 0;
bool skipping = false;
size_t filled = 0;
uint64_t frameStart = 0;

std::atomic<uint64_t> closeKeptAside{0};
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

bool post(Item &item, uint32_t gen)
{
    item.gen = gen;
    if (xQueueSend(inbox, &item, 0) != pdTRUE) {
        return false;
    }
    xTaskNotifyGive(mainTask);
    return true;
}

void postOrKeepClose(Item &item, uint32_t gen)
{
    if (post(item, gen)) {
        return;
    }
    // why: a close lost to a full inbox would leave the link live on a dead socket forever, so it waits beside the queue until the queue drains
    ESP_LOGE(TAG, "rx_inbox_depth=%u, close %d kept aside, queue full", static_cast<unsigned>(kInboxDepth), static_cast<int>(item.code));
    closeKeptAside = (static_cast<uint64_t>(gen) << 32) | static_cast<uint32_t>(item.code);
    xTaskNotifyGive(mainTask);
}

void abandonFill()
{
    if (filling) {
        ringHead = fillStart;
        filling = false;
    }
    skipping = false;
}

std::string failureReason(const esp_websocket_event_data_t &event)
{
    const esp_websocket_error_codes_t &error = event.error_handle;
    if (error.error_type == WEBSOCKET_ERROR_TYPE_PONG_TIMEOUT) {
        return "pong_timeout_sec=" + std::to_string(t3::kPongTimeoutSec) + ", no pong from relay";
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
    if (closePosted.exchange(true)) {
        return;
    }
    abandonFill();
    const uint32_t largest = startLargest.load();
    std::string lowHeap;
    if (!opened && largest < kTlsHeapBytes) {
        lowHeap = "tls_heap=" + std::to_string(kTlsHeapBytes) + ", largest block " + std::to_string(largest);
        reason = lowHeap;
    }
    Item item{TransportEvent::Kind::Close, 0, code, 0, 0, 0, {}};
    const size_t bytes = std::min(reason.size(), kReasonMax);
    std::memcpy(item.reason, reason.data(), bytes);
    item.bytes = static_cast<uint32_t>(bytes);
    postOrKeepClose(item, taskGen);
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
            const uint64_t head = ringHead.load();
            const uint64_t at = head % ringBytes;
            const uint64_t start = at + static_cast<uint64_t>(event.payload_len) > ringBytes ? head + (ringBytes - at) : head;
            if (start + static_cast<uint64_t>(event.payload_len) - ringTail.load() > ringBytes) {
                drop(Drop::RingFull, event.payload_len);
                skipping = true;
            } else {
                fillStart = head;
                ringHead = start + static_cast<uint64_t>(event.payload_len);
                filling = true;
                filled = 0;
                frameStart = start;
            }
        }
    }
    if (skipping || !filling) {
        return;
    }
    std::memcpy(ring + frameStart % ringBytes + filled, event.data_ptr, static_cast<size_t>(event.data_len));
    filled += static_cast<size_t>(event.data_len);
    if (filled < static_cast<size_t>(event.payload_len)) {
        return;
    }
    Item item{TransportEvent::Kind::Text, 0, 0, frameStart, frameStart + filled, static_cast<uint32_t>(filled), {}};
    filling = false;
    if (!post(item, taskGen)) {
        drop(Drop::InboxFull, static_cast<int>(filled));
        ringHead = fillStart;
    }
}

void onWsEvent(void *, esp_event_base_t, int32_t id, void *data)
{
    const auto &event = *static_cast<const esp_websocket_event_data_t *>(data);
    switch (id) {
    case WEBSOCKET_EVENT_BEGIN:
        taskGen = startGen;
        closePosted = false;
        opened = false;
        errorReason.clear();
        abandonFill();
        return;
    case WEBSOCKET_EVENT_CONNECTED: {
        opened = true;
        Item item{TransportEvent::Kind::Open, 0, 0, 0, 0, 0, {}};
        if (!post(item, taskGen)) {
            ESP_LOGE(TAG, "rx_inbox_depth=%u, open dropped, queue full", static_cast<unsigned>(kInboxDepth));
        }
        return;
    }
    case WEBSOCKET_EVENT_DATA:
        if (event.op_code == WS_TRANSPORT_OPCODES_TEXT || event.op_code == WS_TRANSPORT_OPCODES_CONT) {
            onText(event);
        }
        return;
    case WEBSOCKET_EVENT_ERROR:
        if (std::string reason = failureReason(event); !reason.empty()) {
            errorReason = std::move(reason);
        }
        return;
    case WEBSOCKET_EVENT_DISCONNECTED: {
        const std::string reason = failureReason(event);
        postClose(kAbnormalClose, reason.empty() ? errorReason : reason);
        return;
    }
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

void controlLoop(void *)
{
    uint32_t started = 0;
    UBaseType_t stackFreeMin = kControlTaskStackBytes;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        for (uint32_t wanted = wantedGen.load();; wanted = wantedGen.load()) {
            if (started != 0 && started != wanted) {
                esp_websocket_client_stop(client);
                started = 0;
            }
            if (wanted != 0 && started != wanted) {
                size_t largest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
                uint32_t waitedMs = 0;
                for (; largest < kTlsHeapBytes && waitedMs < kTlsHeapWaitMs && wantedGen.load() == wanted;
                     waitedMs += pdTICKS_TO_MS(kTlsHeapPollTicks)) {
                    vTaskDelay(kTlsHeapPollTicks);
                    largest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
                }
                if (wantedGen.load() != wanted) {
                    continue;
                }
                ESP_LOGI(TAG, "tls start after %u ms heap wait, largest block %u", static_cast<unsigned>(waitedMs), static_cast<unsigned>(largest));
                if (largest < kTlsHeapBytes) {
                    ESP_LOGW(TAG, "tls_heap=%u, largest block %u, connecting anyway", static_cast<unsigned>(kTlsHeapBytes), static_cast<unsigned>(largest));
                }
                startLargest = static_cast<uint32_t>(std::min<size_t>(largest, UINT32_MAX));
                started = wanted;
                startGen = wanted;
                if (esp_websocket_client_start(client) != ESP_OK) {
                    Item item{TransportEvent::Kind::Close, 0, kAbnormalClose, 0, 0, 0, {}};
                    constexpr std::string_view kWhy = "websocket start failed";
                    std::memcpy(item.reason, kWhy.data(), kWhy.size());
                    item.bytes = kWhy.size();
                    postOrKeepClose(item, wanted);
                }
            }
            const UBaseType_t stackFree = uxTaskGetStackHighWaterMark(nullptr);
            if (stackFree < stackFreeMin) {
                stackFreeMin = stackFree;
                ESP_LOGI(TAG, "ws_control_stack_free_min=%u of %u", static_cast<unsigned>(stackFree), static_cast<unsigned>(kControlTaskStackBytes));
            }
            if (wantedGen.load() == wanted) {
                break;
            }
        }
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
    ringBytes = kRingFrames * maxFrameBytes;
    ring = static_cast<char *>(malloc(ringBytes));
    ok = ok && ring != nullptr;
    if (!ok) {
        ESP_LOGE(TAG, "rx_ring_bytes=%u alloc failed", static_cast<unsigned>(kRingFrames * maxFrameBytes));
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
    config.ping_interval_sec = t3::kPingIntervalSec;
    config.pingpong_timeout_sec = t3::kPongTimeoutSec;
    client = esp_websocket_client_init(&config);
    if (client == nullptr || esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY, onWsEvent, nullptr) != ESP_OK) {
        ESP_LOGE(TAG, "websocket client init failed");
        return false;
    }
    // why: these IDF tags print the relay host or the whole upgrade request on a failed connect (transport_ws.c "Error connecting to host %s:%d", esp_tls.c "couldn't get hostname for :%s:"); the close reason on screen carries the cause instead
    for (const char *tag : {"websocket_client", "transport_ws", "transport_base", "transport", "esp-tls", "esp-tls-mbedtls", "HTTP_CLIENT"}) {
        esp_log_level_set(tag, ESP_LOG_NONE);
    }
    if (xTaskCreate(controlLoop, "ws_control", kControlTaskStackBytes, nullptr, kControlTaskPriority, &controlTask) != pdPASS) {
        ESP_LOGE(TAG, "ws_control stack=%u alloc failed", static_cast<unsigned>(kControlTaskStackBytes));
        return false;
    }
    return true;
}

bool transport_connect()
{
    wantedGen = generation.fetch_add(1) + 1;
    xTaskNotifyGive(controlTask);
    return true;
}

void transport_close()
{
    generation.fetch_add(1);
    wantedGen = 0;
    xTaskNotifyGive(controlTask);
}

namespace {

bool sendable()
{
    return openGen == generation.load() && wantedGen.load() != 0 && esp_websocket_client_is_connected(client);
}

}

std::optional<std::string> transport_send(std::string_view text)
{
    if (!sendable()) {
        return std::string("not connected, ") + std::to_string(text.size()) + " bytes not sent";
    }
    const int sent = esp_websocket_client_send_text(client, text.data(), static_cast<int>(text.size()), kSendWaitTicks);
    if (sent != static_cast<int>(text.size())) {
        return "send failed, " + std::to_string(text.size()) + " bytes not sent";
    }
    return std::nullopt;
}

std::optional<AudioSendError> transport_send_audio(const int16_t *samples, size_t count, uint32_t waitMs)
{
    const int bytes = static_cast<int>(count * sizeof(int16_t));
    if (!sendable()) {
        return AudioSendError{AudioSendError::Kind::NotConnected, "not connected, " + std::to_string(bytes) + " audio bytes not sent"};
    }
    const int sent = esp_websocket_client_send_bin(client, reinterpret_cast<const char *>(samples), bytes, pdMS_TO_TICKS(waitMs));
    if (sent == bytes) {
        return std::nullopt;
    }
    if (!esp_websocket_client_is_connected(client)) {
        return AudioSendError{AudioSendError::Kind::NotConnected, "connection closed, " + std::to_string(bytes) + " audio bytes not sent"};
    }
    return AudioSendError{AudioSendError::Kind::Stalled, "audio send stalled " + std::to_string(waitMs) + " ms, " + std::to_string(bytes) + " bytes not sent"};
}

std::optional<TransportEvent> transport_poll()
{
    if (mainHolds) {
        ringTail = mainEnd;
        mainHolds = false;
    }
    Item item;
    while (xQueueReceive(inbox, &item, 0) == pdTRUE) {
        if (item.gen != generation.load()) {
            if (item.kind == TransportEvent::Kind::Text) {
                ringTail = item.end;
            }
            continue;
        }
        switch (item.kind) {
        case TransportEvent::Kind::Open:
            openGen = item.gen;
            return TransportEvent{TransportEvent::Kind::Open, 0, {}};
        case TransportEvent::Kind::Text:
            mainEnd = item.end;
            mainHolds = true;
            return TransportEvent{TransportEvent::Kind::Text, 0, std::string_view(ring + item.start % ringBytes, item.bytes)};
        case TransportEvent::Kind::Close:
            closeReason = std::string(item.reason, item.bytes);
            return TransportEvent{TransportEvent::Kind::Close, item.code, closeReason};
        }
    }
    const uint64_t kept = closeKeptAside.exchange(0);
    if (kept != 0 && static_cast<uint32_t>(kept >> 32) == generation.load()) {
        const int32_t code = static_cast<int32_t>(static_cast<uint32_t>(kept));
        closeReason = "rx_inbox_depth=" + std::to_string(kInboxDepth) + ", close " + std::to_string(code) + " needed " + std::to_string(kInboxDepth + 1);
        return TransportEvent{TransportEvent::Kind::Close, code, closeReason};
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
    case Drop::RingFull:
        return "rx_ring_bytes=" + std::to_string(ringBytes) + ", a " + needed + " byte frame did not fit behind the waiting ones";
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
