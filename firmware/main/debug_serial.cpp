#include "debug_serial.h"

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string_view>

#include "display.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "serial_port.h"

namespace {

constexpr char TAG[] = "debug";

constexpr char kStx = 0x02;
constexpr char kEtx = 0x03;

// receipts: docs/receipts/2026-10-21-firmware-baseline.md, section "grid, sprite and debug serial"
constexpr size_t kEchoBytes = 64;
constexpr UBaseType_t kKeyQueueDepth = 16;
constexpr size_t kMaxRowHexBytes = 2 * 120 + 1;

QueueHandle_t keyQueue;
std::atomic<bool> dropRequested{false};
std::atomic<DebugNetCut> netCutRequested{DebugNetCut::None};
std::atomic<uint64_t> powerRequested{0};
std::atomic<bool> staged{false};
std::atomic<bool> stageRequested{false};
std::atomic<std::string *> pendingFrame{nullptr};

void emit(const char *text, size_t len)
{
    std::fwrite(text, 1, len, stdout);
}

void emitLine(const char *format, ...) __attribute__((format(printf, 1, 2)));

void emitLine(const char *format, ...)
{
    char line[kEchoBytes + 64];
    line[0] = kStx;
    va_list args;
    va_start(args, format);
    const int n = std::vsnprintf(line + 1, sizeof(line) - 3, format, args);
    va_end(args);
    const size_t len = n < 0 ? 0 : (static_cast<size_t>(n) < sizeof(line) - 3 ? static_cast<size_t>(n) : sizeof(line) - 3);
    line[1 + len] = kEtx;
    line[2 + len] = '\n';
    emit(line, len + 3);
    std::fflush(stdout);
}

void dumpShot(const DisplayBuffer &buf, void *)
{
    char header[48];
    const int n = std::snprintf(header, sizeof(header), "%cSHOT %d %d %d\n", kStx, buf.width, buf.height, buf.bpp);
    emit(header, static_cast<size_t>(n));
    char row[kMaxRowHexBytes + 1];
    static constexpr char hex[] = "0123456789abcdef";
    for (int y = 0; y < buf.height; ++y) {
        const uint8_t *src = buf.data + static_cast<size_t>(y) * buf.rowBytes;
        size_t o = 0;
        for (size_t i = 0; i < buf.rowBytes; ++i) {
            row[o++] = hex[src[i] >> 4];
            row[o++] = hex[src[i] & 0xf];
        }
        row[o++] = '\n';
        emit(row, o);
    }
    const char end[] = {kEtx, '\n'};
    emit(end, sizeof(end));
    std::fflush(stdout);
}

void sendShot()
{
    display_with_buffer(dumpShot, nullptr);
}

void sendHeap()
{
    emitLine("HEAP heap_internal_free=%u largest_block=%u",
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
             static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
}

void handleKey(std::string_view name)
{
    const auto key = t3::parseKeyName(name);
    if (!key) {
        ESP_LOGW(TAG, "key name unknown, %u bytes", static_cast<unsigned>(name.size()));
        emitLine("ERR key name unknown, %u bytes", static_cast<unsigned>(name.size()));
        return;
    }
    if (xQueueSend(keyQueue, &*key, 0) != pdTRUE) {
        ESP_LOGE(TAG, "key_queue=%u, injected key dropped, queue full", static_cast<unsigned>(kKeyQueueDepth));
        emitLine("ERR key_queue=%u, queue full", static_cast<unsigned>(kKeyQueueDepth));
        return;
    }
    emitLine("KEY ok");
}

void handlePower(std::string_view args)
{
    char text[kEchoBytes];
    std::snprintf(text, sizeof(text), "%.*s", static_cast<int>(args.size()), args.data());
    unsigned dimAfterMs = 0;
    unsigned offAfterMs = 0;
    if (std::sscanf(text, "%u %u", &dimAfterMs, &offAfterMs) != 2 || dimAfterMs == 0 || offAfterMs <= dimAfterMs) {
        emitLine("ERR POWER <dim_ms> <off_ms>, 0 < dim < off");
        return;
    }
    powerRequested = (static_cast<uint64_t>(dimAfterMs) << 32) | offAfterMs;
    emitLine("POWER ok");
}

void handleFrame(std::string_view json)
{
    if (!staged) {
        emitLine("ERR FRAME needs STAGE first, the relay link owns the screen");
        return;
    }
    auto frame = std::make_unique<std::string>(json);
    std::string *idle = nullptr;
    if (!pendingFrame.compare_exchange_strong(idle, frame.get())) {
        emitLine("ERR FRAME busy, the last frame is not taken yet");
        return;
    }
    frame.release();
}

}

bool debug_serial_start()
{
    keyQueue = xQueueCreate(kKeyQueueDepth, sizeof(t3::Key));
    if (keyQueue == nullptr) {
        ESP_LOGE(TAG, "key_queue=%u alloc failed", static_cast<unsigned>(kKeyQueueDepth));
        return false;
    }
    return true;
}

void debug_serial_handle(std::string_view line)
{
    constexpr std::string_view kKeyPrefix = "KEY ";
    constexpr std::string_view kPowerPrefix = "POWER ";
    constexpr std::string_view kFramePrefix = "FRAME ";
    if (line == "SHOT") {
        sendShot();
        ESP_LOGI(TAG, "task_stack_free_min=%u of %u", static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
                 static_cast<unsigned>(kSerialTaskStackBytes));
    } else if (line == "HEAP") {
        sendHeap();
    } else if (line == "DROP") {
        dropRequested = true;
        emitLine("DROP ok");
    } else if (line == "WIFIOFF") {
        netCutRequested = DebugNetCut::LeaveAp;
        emitLine("WIFIOFF ok");
    } else if (line == "NETDOWN") {
        netCutRequested = DebugNetCut::BlackHole;
        emitLine("NETDOWN ok");
    } else if (line == "NETUP") {
        netCutRequested = DebugNetCut::Restore;
        emitLine("NETUP ok");
    } else if (line == "STAGE") {
        staged = true;
        stageRequested = true;
        emitLine("STAGE ok");
    } else if (line.substr(0, kFramePrefix.size()) == kFramePrefix) {
        handleFrame(line.substr(kFramePrefix.size()));
    } else if (line.substr(0, kPowerPrefix.size()) == kPowerPrefix) {
        handlePower(line.substr(kPowerPrefix.size()));
    } else if (line.substr(0, kKeyPrefix.size()) == kKeyPrefix) {
        handleKey(line.substr(kKeyPrefix.size()));
    } else {
        ESP_LOGW(TAG, "command unknown: %.*s", static_cast<int>(line.size()), line.data());
        emitLine("ERR command unknown: %.*s", static_cast<int>(line.size()), line.data());
    }
}

bool debug_serial_poll_key(t3::Key *key)
{
    return keyQueue != nullptr && xQueueReceive(keyQueue, key, 0) == pdTRUE;
}

bool debug_serial_poll_drop()
{
    return dropRequested.exchange(false);
}

DebugNetCut debug_serial_poll_net_cut()
{
    return netCutRequested.exchange(DebugNetCut::None);
}

bool debug_serial_poll_power(uint32_t *dimAfterMs, uint32_t *offAfterMs)
{
    const uint64_t request = powerRequested.exchange(0);
    if (request == 0) {
        return false;
    }
    *dimAfterMs = static_cast<uint32_t>(request >> 32);
    *offAfterMs = static_cast<uint32_t>(request);
    return true;
}

bool debug_serial_poll_stage()
{
    return stageRequested.exchange(false);
}

bool debug_serial_staged()
{
    return staged;
}

std::optional<std::string> debug_serial_poll_frame()
{
    const std::unique_ptr<std::string> frame(pendingFrame.exchange(nullptr));
    if (!frame) {
        return std::nullopt;
    }
    return std::move(*frame);
}

void debug_serial_frame_done(std::string_view screen)
{
    emitLine("FRAME ok screen=%.*s", static_cast<int>(screen.size()), screen.data());
}
