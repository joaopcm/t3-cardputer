#include "keyboard.h"

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "sdkconfig.h"
#include "t3/keymap.h"

namespace {

constexpr char TAG[] = "keyboard";

// receipt: GPIO8/GPIO9 are the ADV's SYS_SDA/SYS_SCL (M5GFX.cpp pin table) and 0x34 is the TCA8418, answered on the ADV by the Task 1 template
constexpr gpio_num_t kSdaPin = GPIO_NUM_8;
constexpr gpio_num_t kSclPin = GPIO_NUM_9;
constexpr uint8_t kAddress = 0x34;
constexpr uint32_t kBusHz = 400000;
constexpr int kTransferTimeoutMs = 100;
constexpr uint8_t kGlitchIgnoreCycles = 7;

constexpr uint8_t kRegConfig = 0x01;
constexpr uint8_t kRegIntStat = 0x02;
constexpr uint8_t kRegKeyEvent = 0x04;
constexpr uint8_t kRegKpGpio1 = 0x1D;
constexpr uint8_t kRegKpGpio2 = 0x1E;
constexpr uint8_t kRegKpGpio3 = 0x1F;
constexpr uint8_t kKeypadRows0to6 = 0x7F;
constexpr uint8_t kKeypadCols0to7 = 0xFF;
constexpr uint8_t kKeypadNoGpio = 0x00;
constexpr uint8_t kConfigKeyInterrupt = 0x01;
constexpr uint8_t kIntStatClearAll = 0x0F;
constexpr uint8_t kEventPressed = 0x80;
constexpr uint8_t kEventCodeMask = 0x7F;

i2c_master_bus_handle_t bus;
i2c_master_dev_handle_t device;
t3::KeyDecoder decoder;

esp_err_t writeReg(uint8_t reg, uint8_t value)
{
    const uint8_t frame[2] = {reg, value};
    return i2c_master_transmit(device, frame, sizeof(frame), kTransferTimeoutMs);
}

esp_err_t readReg(uint8_t reg, uint8_t *value)
{
    return i2c_master_transmit_receive(device, &reg, 1, value, 1, kTransferTimeoutMs);
}

}

bool keyboard_init()
{
    i2c_master_bus_config_t busConfig = {};
    busConfig.i2c_port = I2C_NUM_0;
    busConfig.sda_io_num = kSdaPin;
    busConfig.scl_io_num = kSclPin;
    busConfig.clk_source = I2C_CLK_SRC_DEFAULT;
    busConfig.glitch_ignore_cnt = kGlitchIgnoreCycles;
    busConfig.flags.enable_internal_pullup = true;
    if (i2c_new_master_bus(&busConfig, &bus) != ESP_OK) {
        ESP_LOGE(TAG, "i2c bus on sda=%d scl=%d failed", kSdaPin, kSclPin);
        return false;
    }
    i2c_device_config_t deviceConfig = {};
    deviceConfig.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    deviceConfig.device_address = kAddress;
    deviceConfig.scl_speed_hz = kBusHz;
    if (i2c_master_bus_add_device(bus, &deviceConfig, &device) != ESP_OK) {
        ESP_LOGE(TAG, "tca8418 0x%02x not added to the bus", kAddress);
        return false;
    }
    if (writeReg(kRegKpGpio1, kKeypadRows0to6) != ESP_OK) {
        ESP_LOGE(TAG, "tca8418 0x%02x did not answer: is this a Cardputer ADV?", kAddress);
        return false;
    }
    writeReg(kRegKpGpio2, kKeypadCols0to7);
    writeReg(kRegKpGpio3, kKeypadNoGpio);
    writeReg(kRegConfig, kConfigKeyInterrupt);
    writeReg(kRegIntStat, kIntStatClearAll);
    return true;
}

std::optional<t3::Key> keyboard_poll()
{
    if (device == nullptr) {
        return std::nullopt;
    }
    for (;;) {
        uint8_t event = 0;
        if (readReg(kRegKeyEvent, &event) != ESP_OK || event == 0) {
            return std::nullopt;
        }
        writeReg(kRegIntStat, kIntStatClearAll);
        const uint8_t code = event & kEventCodeMask;
        const bool pressed = (event & kEventPressed) != 0;
        const std::optional<t3::Key> key = decoder.onEvent(code, pressed);
#ifdef CONFIG_T3_KEYBOARD_TRACE
        ESP_LOGI(TAG, "event code=%u %s", static_cast<unsigned>(code), pressed ? "down" : "up");
#endif
        if (key) {
            return key;
        }
    }
}
