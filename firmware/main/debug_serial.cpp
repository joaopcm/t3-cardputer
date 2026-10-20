#include "debug_serial.h"

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string_view>

#include "display.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

namespace {

constexpr char TAG[] = "debug";

constexpr char kStx = 0x02;
constexpr char kEtx = 0x03;

// receipts: docs/receipts/2026-10-21-firmware-baseline.md, section "grid, sprite and debug serial"
constexpr uint32_t kRxBufferBytes = 256;
constexpr uint32_t kTxBufferBytes = 1024;
constexpr size_t kMaxLineBytes = 64;
constexpr uint32_t kTaskStackBytes = 4096;
constexpr UBaseType_t kTaskPriority = 3;
constexpr UBaseType_t kKeyQueueDepth = 16;
constexpr size_t kMaxRowHexBytes = 2 * 120 + 1;

QueueHandle_t keyQueue;
std::atomic<bool> dropRequested{false};

void emit(const char *text, size_t len)
{
    std::fwrite(text, 1, len, stdout);
}

void emitLine(const char *format, ...) __attribute__((format(printf, 1, 2)));

void emitLine(const char *format, ...)
{
    char line[kMaxLineBytes + 64];
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

void handleLine(std::string_view line)
{
    constexpr std::string_view kKeyPrefix = "KEY ";
    if (line == "SHOT") {
        sendShot();
        ESP_LOGI(TAG, "task_stack_free_min=%u of %u", static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
                 static_cast<unsigned>(kTaskStackBytes));
    } else if (line == "HEAP") {
        sendHeap();
    } else if (line == "DROP") {
        dropRequested = true;
        emitLine("DROP ok");
    } else if (line.substr(0, kKeyPrefix.size()) == kKeyPrefix) {
        handleKey(line.substr(kKeyPrefix.size()));
    } else {
        ESP_LOGW(TAG, "command unknown: %.*s", static_cast<int>(line.size()), line.data());
        emitLine("ERR command unknown: %.*s", static_cast<int>(line.size()), line.data());
    }
}

void serialTask(void *)
{
    char line[kMaxLineBytes];
    size_t len = 0;
    bool inCommand = false;
    bool overflowed = false;
    for (;;) {
        uint8_t byte;
        if (usb_serial_jtag_read_bytes(&byte, 1, portMAX_DELAY) != 1) {
            continue;
        }
        if (byte == kStx) {
            inCommand = true;
            overflowed = false;
            len = 0;
        } else if (!inCommand) {
            continue;
        } else if (byte == '\n') {
            inCommand = false;
            if (overflowed) {
                ESP_LOGE(TAG, "line_buf=%u, command needed more", static_cast<unsigned>(kMaxLineBytes));
            } else {
                handleLine(std::string_view(line, len));
            }
        } else if (len < kMaxLineBytes) {
            line[len++] = static_cast<char>(byte);
        } else {
            overflowed = true;
        }
    }
}

}

bool debug_serial_start()
{
    usb_serial_jtag_driver_config_t config = {.tx_buffer_size = kTxBufferBytes, .rx_buffer_size = kRxBufferBytes};
    if (usb_serial_jtag_driver_install(&config) != ESP_OK) {
        ESP_LOGE(TAG, "usb_serial_jtag driver install failed, rx=%u tx=%u", static_cast<unsigned>(kRxBufferBytes),
                 static_cast<unsigned>(kTxBufferBytes));
        return false;
    }
    usb_serial_jtag_vfs_use_driver();
    keyQueue = xQueueCreate(kKeyQueueDepth, sizeof(t3::Key));
    if (keyQueue == nullptr || xTaskCreate(serialTask, "debug_serial", kTaskStackBytes, nullptr, kTaskPriority, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "debug task or key_queue=%u alloc failed", static_cast<unsigned>(kKeyQueueDepth));
        return false;
    }
    return true;
}

bool debug_serial_poll_key(t3::Key *key)
{
    return keyQueue != nullptr && xQueueReceive(keyQueue, key, 0) == pdTRUE;
}

bool debug_serial_poll_drop()
{
    return dropRequested.exchange(false);
}
