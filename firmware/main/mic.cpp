#include "mic.h"

#include <atomic>

#include "driver/i2s_tdm.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "t3/protocol.h"

namespace {

constexpr char TAG[] = "mic";

// receipt: M5Unified 0.2.27 M5Unified.inl, board_M5CardputerADV mic_cfg: data in GPIO46, ws GPIO43, bck GPIO41, no mclk; I2S_NUM_0 is Mic_Class's default port
constexpr gpio_num_t kPinBck = GPIO_NUM_41;
constexpr gpio_num_t kPinWs = GPIO_NUM_43;
constexpr gpio_num_t kPinDin = GPIO_NUM_46;
constexpr i2s_port_t kPort = I2S_NUM_0;
// receipt: docs/receipts/2026-10-21-firmware-voice.md "dma"
constexpr uint32_t kDmaChunks = 4;
// receipt: docs/receipts/2026-10-21-firmware-voice.md "warm-up", the ADC gave 1.0 s of zeros after its first clock start, 2x; it overlaps the WiFi join
constexpr uint32_t kWarmUpMs = 2000;

// receipt: M5Unified 0.2.27 M5Unified.inl es8311_i2c_addr0, written at 100 kHz by in_i2c_bulk_write
constexpr uint8_t kCodecAddress = 0x18;
constexpr uint32_t kCodecBusHz = 100000;
// receipt: the keyboard's kTransferTimeoutMs on the same bus; a 2-byte write at 100 kHz takes about 0.3 ms, so 100 ms only trips on a hung bus
constexpr int kCodecTimeoutMs = 100;

constexpr uint8_t kRegPga = 0x14;
constexpr uint8_t kRegAdcScale = 0x16;
constexpr uint8_t kRegAdcVolume = 0x17;
// receipt: ES8311 datasheet REG14, bit 4 selects Mic1p-Mic1n, bits 3:0 are the PGA gain in 3 dB steps (0 to 10 = 0 to 30 dB)
constexpr uint8_t kPgaMic1 = 0x10;
// receipt: docs/receipts/2026-10-21-firmware-voice.md "gain"
constexpr uint8_t kPgaGainSteps = 10;
constexpr uint8_t kAdcScaleSteps = 3;
constexpr uint8_t kAdcVolume = 0xBF;

struct Reg {
    uint8_t reg;
    uint8_t value;
};

// receipt: M5Unified 0.2.27 M5Unified.inl _microphone_enabled_cb_cardputer_adv, the ADV's capture table; the gain registers follow it
constexpr Reg kCodecOn[] = {
    {0x00, 0x80},
    {0x01, 0xBA},
    {0x02, 0x18},
    {0x0D, 0x01},
    {0x0E, 0x02},
    {0x1C, 0x6A},
    {kRegPga, kPgaMic1 | kPgaGainSteps},
    {kRegAdcScale, kAdcScaleSteps},
    {kRegAdcVolume, kAdcVolume},
};

i2s_chan_handle_t rx;
TaskHandle_t reader;
i2c_master_dev_handle_t codec;
std::atomic<uint32_t> lostChunks{0};
uint32_t lostSeen = 0;
bool ready = false;
bool running = false;

bool IRAM_ATTR onRecv(i2s_chan_handle_t, i2s_event_data_t *, void *)
{
    BaseType_t woken = pdFALSE;
    vTaskNotifyGiveFromISR(reader, &woken);
    return woken == pdTRUE;
}

bool IRAM_ATTR onOverflow(i2s_chan_handle_t, i2s_event_data_t *, void *)
{
    lostChunks.fetch_add(1);
    return false;
}

esp_err_t writeTable(const Reg *table, size_t count)
{
    for (size_t i = 0; i < count; ++i) {
        const uint8_t frame[2] = {table[i].reg, table[i].value};
        if (const esp_err_t err = i2c_master_transmit(codec, frame, sizeof(frame), kCodecTimeoutMs); err != ESP_OK) {
            return err;
        }
    }
    return ESP_OK;
}

}

bool mic_init(i2c_master_bus_handle_t bus)
{
    if (bus == nullptr) {
        ESP_LOGE(TAG, "no i2c bus for the es8311");
        return false;
    }
    i2c_device_config_t deviceConfig = {};
    deviceConfig.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    deviceConfig.device_address = kCodecAddress;
    deviceConfig.scl_speed_hz = kCodecBusHz;
    if (i2c_master_bus_add_device(bus, &deviceConfig, &codec) != ESP_OK) {
        ESP_LOGE(TAG, "es8311 0x%02x not added to the bus", kCodecAddress);
        return false;
    }

    reader = xTaskGetCurrentTaskHandle();
    i2s_chan_config_t chanConfig = I2S_CHANNEL_DEFAULT_CONFIG(kPort, I2S_ROLE_MASTER);
    chanConfig.dma_desc_num = kDmaChunks;
    chanConfig.dma_frame_num = kMicChunkSamples;
    if (i2s_new_channel(&chanConfig, nullptr, &rx) != ESP_OK) {
        ESP_LOGE(TAG, "mic_dma_bytes=%u alloc failed", static_cast<unsigned>(kDmaChunks * kMicChunkSamples * sizeof(int16_t)));
        return false;
    }
    i2s_tdm_config_t tdmConfig = {
        .clk_cfg = I2S_TDM_CLK_DEFAULT_CONFIG(t3::kAudioSampleRate),
        .slot_cfg = I2S_TDM_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_TDM_SLOT0),
        .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = kPinBck, .ws = kPinWs, .dout = I2S_GPIO_UNUSED, .din = kPinDin, .invert_flags = {}},
    };
    // why: the ES8311 clocks itself from BCLK as 32 bits per frame (M5Unified's MCLK=BCLK table), so the frame keeps two 16-bit slots; in std mono mode the S3's RX DMA still wrote both (equal sample pairs at twice the rate, docs/receipts/2026-10-21-firmware-voice.md "one slot"), TDM with slot 0 active writes only the mic's
    tdmConfig.slot_cfg.total_slot = 2;
    i2s_event_callbacks_t callbacks = {};
    callbacks.on_recv_q_ovf = onOverflow;
    callbacks.on_recv = onRecv;
    if (i2s_channel_init_tdm_mode(rx, &tdmConfig) != ESP_OK || i2s_channel_register_event_callback(rx, &callbacks, nullptr) != ESP_OK ||
        i2s_channel_enable(rx) != ESP_OK) {
        ESP_LOGE(TAG, "i2s tdm rx init failed");
        return false;
    }
    // why: the ES8311 takes its capture setup only while the I2S clock runs (M5Unified 0.2.27 _microphone_post_start_cb_stopwatch), and its ADC needs a second of clock once per power-up, so it is set up and warmed once here and stays powered
    const esp_err_t err = writeTable(kCodecOn, std::size(kCodecOn));
    vTaskDelay(pdMS_TO_TICKS(kWarmUpMs));
    i2s_channel_disable(rx);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "es8311 setup failed, %s", esp_err_to_name(err));
        return false;
    }
    ready = true;
    return true;
}

std::optional<std::string> mic_start()
{
    if (!ready) {
        return std::string("mic: not initialised, see the boot log");
    }
    if (i2s_channel_enable(rx) != ESP_OK) {
        return std::string("mic: i2s enable failed");
    }
    lostChunks = 0;
    lostSeen = 0;
    running = true;
    return std::nullopt;
}

size_t mic_read(int16_t *buf, size_t n, uint32_t waitMs)
{
    if (!running) {
        return 0;
    }
    size_t bytes = 0;
    i2s_channel_read(rx, buf, n * sizeof(int16_t), &bytes, waitMs);
    return bytes / sizeof(int16_t);
}

void mic_stop()
{
    if (!running) {
        return;
    }
    running = false;
    i2s_channel_disable(rx);
}

std::optional<std::string> mic_lost()
{
    const uint32_t lost = lostChunks.load();
    if (lost == lostSeen) {
        return std::nullopt;
    }
    lostSeen = lost;
    return "mic_buffer_ms=" + std::to_string((kDmaChunks - 1) * kMicChunkMs) + ", a stall lost " + std::to_string(lost * kMicChunkMs) +
           " ms of audio";
}

