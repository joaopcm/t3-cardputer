
#include <cstdio>

#include "driver/i2c_master.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define M5GFX_BOARD lgfx::boards::board_M5CardputerADV
#include <M5GFX.h>

namespace {

constexpr char TAG[] = "hello";
constexpr char T3_TAG[] = "t3";

constexpr gpio_num_t KBD_SDA = GPIO_NUM_8;
constexpr gpio_num_t KBD_SCL = GPIO_NUM_9;
constexpr uint8_t KBD_ADDR = 0x34;
constexpr uint32_t KBD_HZ = 400000;

constexpr uint8_t TCA_REG_CFG = 0x01;
constexpr uint8_t TCA_REG_INT_STAT = 0x02;
constexpr uint8_t TCA_REG_KEY_EVENT_A = 0x04;
constexpr uint8_t TCA_REG_KP_GPIO1 = 0x1D;
constexpr uint8_t TCA_REG_KP_GPIO2 = 0x1E;
constexpr uint8_t TCA_REG_KP_GPIO3 = 0x1F;

M5GFX display;
i2c_master_bus_handle_t i2c_bus;
i2c_master_dev_handle_t tca;

esp_err_t tca_write(uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = {reg, val};
    return i2c_master_transmit(tca, buf, sizeof(buf), 100);
}

esp_err_t tca_read(uint8_t reg, uint8_t *val)
{
    return i2c_master_transmit_receive(tca, &reg, 1, val, 1, 100);
}

bool kbd_init()
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = KBD_SDA,
        .scl_io_num = KBD_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .intr_priority = 0,
        .trans_queue_depth = 0,
        .flags = {.enable_internal_pullup = true},
    };
    if (i2c_new_master_bus(&bus_cfg, &i2c_bus) != ESP_OK) {
        return false;
    }

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = KBD_ADDR,
        .scl_speed_hz = KBD_HZ,
    };
    if (i2c_master_bus_add_device(i2c_bus, &dev_cfg, &tca) != ESP_OK) {
        return false;
    }

    if (tca_write(TCA_REG_KP_GPIO1, 0x7F) != ESP_OK) {
        return false;
    }
    tca_write(TCA_REG_KP_GPIO2, 0xFF);
    tca_write(TCA_REG_KP_GPIO3, 0x00);
    tca_write(TCA_REG_CFG, 0x01);
    tca_write(TCA_REG_INT_STAT, 0x0F);
    return true;
}

bool kbd_poll_press(uint8_t *keycode)
{
    uint8_t ev = 0;
    if (tca_read(TCA_REG_KEY_EVENT_A, &ev) != ESP_OK || ev == 0) {
        return false;
    }
    tca_write(TCA_REG_INT_STAT, 0x0F);
    if ((ev & 0x80) == 0) {
        return false;
    }
    *keycode = ev & 0x7F;
    return true;
}

void log_heap(const char *label)
{
    ESP_LOGI(T3_TAG, "%s heap_internal_free=%u largest_block=%u", label,
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
             static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
}

}

extern "C" void app_main(void)
{
    log_heap("boot");
    ESP_LOGI(T3_TAG, "relay_url_len=%u", static_cast<unsigned>(sizeof(T3_RELAY_URL) - 1));
    display.init();
    log_heap("display");
    display.setRotation(1);
    display.fillScreen(TFT_BLACK);
    display.setTextColor(TFT_WHITE, TFT_BLACK);
    display.setTextSize(2);
    display.setCursor(8, 40);
    display.print("Hello world!");
    display.setTextSize(1);
    display.setCursor(8, 80);
    display.print("Press any key...");

    if (!kbd_init()) {
        ESP_LOGE(TAG, "TCA8418 init failed — is this a Cardputer ADV?");
        display.setCursor(8, 100);
        display.setTextColor(TFT_RED, TFT_BLACK);
        display.print("No TCA8418");
        return;
    }

    ESP_LOGI(TAG, "Waiting for key...");
    uint8_t key = 0;
    for (;;) {
        if (kbd_poll_press(&key)) {
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }

    char line[32];
    std::snprintf(line, sizeof(line), "key %u", static_cast<unsigned>(key));
    ESP_LOGI(TAG, "%s", line);

    display.fillScreen(TFT_DARKGREEN);
    display.setTextColor(TFT_WHITE, TFT_DARKGREEN);
    display.setTextSize(2);
    display.setCursor(8, 50);
    display.print(line);
}
