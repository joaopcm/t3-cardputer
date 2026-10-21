#include "serial_port.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>

#include "debug_serial.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "t3/provision.h"

namespace {

constexpr char TAG[] = "serial";

constexpr char kStx = 0x02;
constexpr std::string_view kProvisionPrefix = "T3PROV ";
constexpr std::string_view kMisframedReply = "T3PROV err provision: frames are \"T3PROV <json>\" or \"T3INFO\"";

// receipts: docs/receipts/2026-10-21-firmware-baseline.md, section "grid, sprite and debug serial"
constexpr uint32_t kRxBufferBytes = 256;
constexpr uint32_t kTxBufferBytes = 1024;
constexpr UBaseType_t kTaskPriority = 3;
// receipt: the longest reply (an err line, under 1100 bytes) is 18 full-speed 64-byte packets, 18 ms at one packet per 1 ms USB frame; 100 ms keeps the restart after `ok` inside the 500 ms docs/protocol.md "USB provisioning" promises
constexpr TickType_t kReplyDrainTicks = pdMS_TO_TICKS(100);

char lineBytes[t3::kProvisionLineMax];
enum class HandOff : uint8_t { None, Provision, DebugLine };

size_t handOffSize = 0;
std::atomic<HandOff> handOff{HandOff::None};
std::atomic<bool> infoRequested{false};
TaskHandle_t serialTaskHandle;

void logStack()
{
    ESP_LOGI(TAG, "task_stack_free_min=%u of %u", static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)),
             static_cast<unsigned>(kSerialTaskStackBytes));
}

void handOver(HandOff kind, size_t len)
{
    handOffSize = len;
    handOff.store(kind, std::memory_order_release);
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
}

std::optional<std::string> takeHandOff(HandOff kind, size_t prefixBytes)
{
    if (handOff.load(std::memory_order_acquire) != kind) {
        return std::nullopt;
    }
    std::string text(lineBytes + prefixBytes, handOffSize - prefixBytes);
    handOff.store(HandOff::None, std::memory_order_release);
    xTaskNotifyGive(serialTaskHandle);
    return text;
}

void route(std::string_view text)
{
    switch (t3::classifySerialLine(text)) {
    case t3::SerialLine::Provision:
        handOver(HandOff::Provision, text.size());
        break;
    case t3::SerialLine::Info:
        infoRequested = true;
        break;
    case t3::SerialLine::Misframed:
        serial_port_reply(kMisframedReply);
        break;
    case t3::SerialLine::Other:
#ifdef CONFIG_T3_DEBUG_SERIAL
        debug_serial_handle(text);
#endif
        return;
    }
    logStack();
}

void overflowed(std::string_view head, size_t needed)
{
    if (t3::classifySerialLine(head) != t3::SerialLine::Other) {
        serial_port_reply("T3PROV err provision_line_max=" + std::to_string(t3::kProvisionLineMax) + ", line needed " + std::to_string(needed));
        logStack();
        return;
    }
#ifdef CONFIG_T3_DEBUG_SERIAL
    ESP_LOGE(TAG, "provision_line_max=%u, line needed %u", static_cast<unsigned>(t3::kProvisionLineMax), static_cast<unsigned>(needed));
#endif
}

void serialTask(void *)
{
    size_t len = 0;
    bool inLine = false;
    for (;;) {
        uint8_t byte;
        if (usb_serial_jtag_read_bytes(&byte, 1, portMAX_DELAY) != 1) {
            continue;
        }
        if (byte == kStx) {
            inLine = true;
            len = 0;
        } else if (!inLine) {
            continue;
        } else if (byte == '\n') {
            inLine = false;
            if (len > sizeof(lineBytes)) {
                overflowed(std::string_view(lineBytes, sizeof(lineBytes)), len);
            } else {
                route(std::string_view(lineBytes, len));
            }
            std::memset(lineBytes, 0, std::min(len, sizeof(lineBytes)));
        } else {
            if (len < sizeof(lineBytes)) {
                lineBytes[len] = static_cast<char>(byte);
            }
            ++len;
        }
    }
}

}

bool serial_port_start()
{
    usb_serial_jtag_driver_config_t config = {.tx_buffer_size = kTxBufferBytes, .rx_buffer_size = kRxBufferBytes};
    if (usb_serial_jtag_driver_install(&config) != ESP_OK) {
        ESP_LOGE(TAG, "usb_serial_jtag driver install failed, rx=%u tx=%u", static_cast<unsigned>(kRxBufferBytes),
                 static_cast<unsigned>(kTxBufferBytes));
        return false;
    }
    usb_serial_jtag_vfs_use_driver();
    // why: the console default turns \n into \r\n, and docs/protocol.md "USB provisioning" frames end in a bare \n
    usb_serial_jtag_vfs_set_tx_line_endings(ESP_LINE_ENDINGS_LF);
    // why: the key queue goes after the driver rings; queue first left the reconnect after a voice drop a 55296 largest block, under the 60398 TLS line (docs/receipts/2026-10-21-firmware-voice.md "heap")
    if (!debug_serial_start()) {
        return false;
    }
    if (xTaskCreate(serialTask, "serial_port", kSerialTaskStackBytes, nullptr, kTaskPriority, &serialTaskHandle) != pdPASS) {
        ESP_LOGE(TAG, "serial task alloc failed, stack=%u", static_cast<unsigned>(kSerialTaskStackBytes));
        return false;
    }
    return true;
}

std::optional<std::string> serial_port_poll_provision()
{
    return takeHandOff(HandOff::Provision, kProvisionPrefix.size());
}

#ifdef CONFIG_T3_DEBUG_SERIAL
void serial_port_hand_over_debug_line(size_t len)
{
    handOver(HandOff::DebugLine, len);
}

std::optional<std::string> serial_port_poll_debug_line(size_t prefixBytes)
{
    return takeHandOff(HandOff::DebugLine, prefixBytes);
}
#endif

bool serial_port_poll_info()
{
    return infoRequested.exchange(false);
}

void serial_port_reply(std::string_view line)
{
    const std::string out = kStx + t3::printableLine(line) + '\n';
    std::fwrite(out.data(), 1, out.size(), stdout);
    std::fflush(stdout);
    usb_serial_jtag_wait_tx_done(kReplyDrainTicks);
}
