#include <cstdio>

#include "debug_serial.h"
#include "demo_relay.h"
#include "display.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "t3/app.h"
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

// why: demo only until Task 8 sends hello with measured values; maxHomeRows 16 fits the canned home (10 rows), frames use the protocol device cap
constexpr t3::HelloCaps kDemoCaps{t3::Grid::Cols, 8, t3::kDeviceFrameBytesMax, 16};

uint32_t now_ms()
{
    return static_cast<uint32_t>(esp_timer_get_time() / 1000);
}

void draw(const t3::App &app)
{
    t3::Grid grid;
    app.draw(grid);
    display_draw(grid);
}

void feed(t3::App &app, const t3::App::Out &out)
{
    for (const std::string &frame : out.send) {
        for (const std::string &answer : demo_relay_answer(frame)) {
            feed(app, app.onFrame(answer, now_ms()));
        }
    }
}

}

extern "C" void app_main(void)
{
    log_heap("boot");
    if (!display_init()) {
        return;
    }
    log_heap("sprite");
    static t3::App app(kDemoCaps, (static_cast<uint64_t>(esp_random()) << 32) | esp_random());
    app.onLinkStatus("");
    feed(app, app.onFrame(kDemoHome, now_ms()));
    draw(app);
    debug_serial_start();
    log_heap("ready");
    ESP_LOGI(TAG, "demo relay: canned home until the relay link lands");

    for (;;) {
        t3::Key key;
        while (debug_serial_poll_key(&key)) {
            ESP_LOGI(TAG, "key %s", t3::keyNameString(key).c_str());
            feed(app, app.onKey(key, now_ms()));
            draw(app);
            ESP_LOGI(TAG, "screen %.*s", static_cast<int>(app.screenName().size()), app.screenName().data());
        }
        vTaskDelay(kMainPollTicks);
    }
}
