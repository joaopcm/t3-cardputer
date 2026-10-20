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
#include "keyboard.h"
#include "settings.h"
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

std::vector<t3::WifiNet> demo_scan()
{
    std::vector<t3::WifiNet> nets = {{"demo-net-a", -48, true, false}, {"demo-net-b", -61, true, false}, {"demo-open", -70, false, false}};
    for (const settings::WifiCred &saved : settings::wifi()) {
        bool found = false;
        for (t3::WifiNet &net : nets) {
            if (net.ssid == saved.ssid) {
                net.saved = true;
                found = true;
            }
        }
        if (!found) {
            nets.push_back({saved.ssid, -80, true, true});
        }
    }
    return nets;
}

// why: demo only until Task 8 joins WiFi and posts /v1/pair; both fake a success so the NVS round trip can be walked on the device
void feed(t3::App &app, const t3::App::Out &out)
{
    if (out.scanWifi) {
        app.onWifiScan(demo_scan());
    }
    if (out.forgetWifi) {
        const std::optional<std::string> error = settings::removeWifi(*out.forgetWifi);
        app.onWifiForgotten(*out.forgetWifi, !error, error.value_or(""));
    }
    if (out.joinWifi) {
        const std::optional<std::string> error = settings::addWifi({out.joinWifi->ssid, out.joinWifi->password});
        feed(app, app.onWifiResult(!error, error.value_or("")));
    }
    if (out.pair) {
        feed(app, app.onPairResult("demo-token-" + out.pair->code, ""));
    }
    if (out.storeToken) {
        const std::optional<std::string> error = settings::setToken(*out.storeToken);
        feed(app, app.onTokenStored(!error, error.value_or("")));
    }
    for (const std::string &frame : out.send) {
        for (const std::string &answer : demo_relay_answer(frame)) {
            feed(app, app.onFrame(answer, now_ms()));
        }
    }
}

std::string loggedKey(const t3::Key &key)
{
    return key.name == t3::KeyName::Char ? "char:*" : t3::keyNameString(key);
}

void show_fatal(std::string_view message)
{
    ESP_LOGE(TAG, "%.*s", static_cast<int>(message.size()), message.data());
    t3::Grid grid;
    grid.put(0, 0, "setup", t3::Color::Text);
    int row = 2;
    for (const std::string &line : t3::wrapWords(message, t3::Grid::Cols)) {
        grid.put(row++, 0, line, t3::Color::Red);
    }
    grid.put(row + 1, 0, "wifi and the token cannot be saved", t3::Color::Warn);
    display_draw(grid);
}

void handle_key(t3::App &app, const t3::Key &key)
{
    ESP_LOGI(TAG, "key %s", loggedKey(key).c_str());
    feed(app, app.onKey(key, now_ms()));
    draw(app);
    ESP_LOGI(TAG, "screen %.*s", static_cast<int>(app.screenName().size()), app.screenName().data());
}

}

extern "C" void app_main(void)
{
    log_heap("boot");
    if (!display_init()) {
        return;
    }
    log_heap("sprite");
    if (const std::optional<std::string> error = settings::init()) {
        show_fatal(*error);
        debug_serial_start();
        for (;;) {
            vTaskDelay(portMAX_DELAY);
        }
    }
    const bool keyboard_ok = keyboard_init();
    ESP_LOGI(TAG, "keyboard %s", keyboard_ok ? "ready" : "missing");
    static t3::App app(kDemoCaps, (static_cast<uint64_t>(esp_random()) << 32) | esp_random());
    app.onLinkStatus("");
    feed(app, app.onFrame(kDemoHome, now_ms()));
    feed(app, app.onBoot(!settings::wifi().empty(), settings::token().has_value()));
    draw(app);
    debug_serial_start();
    log_heap("ready");
    ESP_LOGI(TAG, "demo relay: canned home until the relay link lands");

    for (;;) {
        t3::Key key;
        while (debug_serial_poll_key(&key)) {
            handle_key(app, key);
        }
        while (const std::optional<t3::Key> pressed = keyboard_poll()) {
            handle_key(app, *pressed);
        }
        vTaskDelay(kMainPollTicks);
    }
}
