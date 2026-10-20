#include <cstdio>

#include "debug_serial.h"
#include "display.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "t3/grid.h"
#include "t3/keys.h"

namespace {

constexpr char TAG[] = "t3";
constexpr TickType_t kMainPollTicks = pdMS_TO_TICKS(20);

void log_heap(const char *label)
{
    ESP_LOGI(TAG, "%s heap_internal_free=%u largest_block=%u", label,
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
             static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
}

void draw_test_grid()
{
    using t3::Color;
    t3::Grid grid;
    grid.put(0, 0, "T3 - homelab");
    grid.put(0, 32, "wifi 82%");
    grid.put(1, 0, "NEEDS YOU (2)", Color::Warn);
    grid.put(2, 0, "! resend-api   fix bounce webhook   3m", Color::Hdr);
    grid.selectRow(2);
    grid.put(3, 0, "? weaver       layout engine plan   9m", Color::Warn);
    grid.put(4, 0, "RUNNING (3)", Color::Run);
    grid.put(5, 0, "* homelab      nightly backup cron  12m");
    grid.put(6, 0, "* resend-api   flaky test sweep      4m");
    grid.put(7, 0, "* weaver       measure arena sizes   1m");
    grid.put(8, 0, "DONE TODAY (5) >", Color::Ok);
    grid.put(10, 0, "^v move  Enter open  N new  R refresh");
    display_draw(grid);
}

}

extern "C" void app_main(void)
{
    log_heap("boot");
    if (!display_init()) {
        return;
    }
    log_heap("sprite");
    draw_test_grid();
    debug_serial_start();
    log_heap("ready");

    for (;;) {
        t3::Key key;
        while (debug_serial_poll_key(&key)) {
            ESP_LOGI(TAG, "key %s", t3::keyNameString(key).c_str());
        }
        vTaskDelay(kMainPollTicks);
    }
}
