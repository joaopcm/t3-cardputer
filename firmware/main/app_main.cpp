#include <cstdio>
#include <map>

#include "debug_serial.h"
#include "display.h"
#include "esp_app_desc.h"
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
#include "t3/link.h"
#include "transport.h"
#include "wifi.h"

namespace {

constexpr char TAG[] = "t3";
constexpr TickType_t kMainPollTicks = pdMS_TO_TICKS(20);
// receipt: RFC 6455 section 7.4.1, 1006 is a close with no close frame, which is what a dropped socket looks like to the link
constexpr int kAbnormalClose = 1006;

// receipt: docs/receipts/2026-10-21-firmware-network.md "hello caps"; bodyRows 7 is the controller ruling (thread screen: bar, header, reply line, hint)
constexpr t3::HelloCaps kCaps{t3::Grid::Cols, 7, 8192, 32};

void log_heap(const char *label)
{
    ESP_LOGI(TAG, "%s heap_internal_free=%u largest_block=%u", label,
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
             static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
}

uint32_t now_ms()
{
    return static_cast<uint32_t>(esp_timer_get_time() / 1000);
}

std::string loggedKey(const t3::Key &key)
{
    return key.name == t3::KeyName::Char ? "char:*" : t3::keyNameString(key);
}

std::string_view frameType(std::string_view frame)
{
    constexpr std::string_view kTypeKey = "\"type\":\"";
    const size_t at = frame.find(kTypeKey);
    if (at == std::string_view::npos) {
        return "?";
    }
    const size_t start = at + kTypeKey.size();
    const size_t end = frame.find('"', start);
    return end == std::string_view::npos ? std::string_view("?") : frame.substr(start, end - start);
}

class Device {
public:
    Device(const t3::HelloCaps &caps, uint64_t seed, std::string token)
        : app_(caps, seed), link_(caps, std::move(token), esp_app_get_description()->version)
    {
    }

    t3::App &app() { return app_; }

    void boot(bool hasWifi, bool hasToken)
    {
        feed(app_.onBoot(hasWifi, hasToken));
        if (hasWifi) {
            wifi_start(now_ms());
        }
    }

    void key(const t3::Key &key)
    {
        ESP_LOGI(TAG, "key %s", loggedKey(key).c_str());
        feed(app_.onKey(key, now_ms()));
        ESP_LOGI(TAG, "screen %.*s", static_cast<int>(app_.screenName().size()), app_.screenName().data());
        dirty_ = true;
    }

    void poll()
    {
        while (std::optional<WifiEvent> event = wifi_poll(now_ms())) {
            onWifi(*event);
            dirty_ = true;
        }
        while (std::optional<TransportEvent> event = transport_poll()) {
            onTransport(*event);
            dirty_ = true;
        }
        if (std::optional<std::string> dropped = transport_dropped()) {
            ESP_LOGE(TAG, "%s", dropped->c_str());
            app_.onTransportError(*dropped);
            dirty_ = true;
        }
        if (std::optional<PairDone> done = pair_poll()) {
            onPairDone(*done);
            dirty_ = true;
        }
        if (debug_serial_poll_drop()) {
            ESP_LOGI(TAG, "debug: dropping the relay socket");
            transport_close();
            apply(link_.onClose(kAbnormalClose, "debug drop", now_ms()));
            dirty_ = true;
        }
        apply(link_.onTick(now_ms()));
    }

    bool takeDirty()
    {
        const bool was = dirty_;
        dirty_ = false;
        return was;
    }

private:
    void apply(const t3::Link::Out &out)
    {
        if (out.closeSocket) {
            transport_close();
        }
        if (out.wipeToken) {
            if (const std::optional<std::string> error = settings::wipeToken()) {
                ESP_LOGE(TAG, "%s", error->c_str());
            }
            feed(app_.onAuthRejected());
        }
        for (const std::string &frame : out.send) {
            if (const std::optional<std::string> error = transport_send(frame)) {
                ESP_LOGE(TAG, "hello: %s", error->c_str());
            }
        }
        if (out.connect) {
            log_heap("connect");
            if (!transport_connect()) {
                apply(link_.onClose(kAbnormalClose, "websocket start failed", now_ms()));
                return;
            }
        }
        if (out.statusText) {
            ESP_LOGI(TAG, "link %s", out.statusText->empty() ? "live" : out.statusText->c_str());
            if (out.statusText->empty()) {
                log_heap("live");
                ESP_LOGI(TAG, "main_task_stack_free_min=%u", static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
            }
            feed(app_.onLinkStatus(*out.statusText));
            dirty_ = true;
        }
    }

    void onTransport(const TransportEvent &event)
    {
        switch (event.kind) {
        case TransportEvent::Kind::Open:
            log_heap("open");
            apply(link_.onOpen(now_ms()));
            return;
        case TransportEvent::Kind::Text: {
            noteFrame(event.text);
            const t3::Link::Out out = link_.onText(event.text, now_ms());
            const bool toApp = out.passToApp;
            apply(out);
            if (toApp) {
                feed(app_.onFrame(event.text, now_ms()));
            }
            return;
        }
        case TransportEvent::Kind::Close:
            ESP_LOGI(TAG, "closed %d%s%.*s", event.closeCode, event.text.empty() ? "" : ": ", static_cast<int>(event.text.size()),
                     event.text.data());
            apply(link_.onClose(event.closeCode, event.text, now_ms()));
            return;
        }
    }

    void noteFrame(std::string_view frame)
    {
        const std::string type(frameType(frame));
        size_t &largest = largestFrame_[type];
        if (frame.size() > largest) {
            largest = frame.size();
            ESP_LOGI(TAG, "rx largest %s frame %u bytes", type.c_str(), static_cast<unsigned>(largest));
        }
    }

    void onWifi(const WifiEvent &event)
    {
        switch (event.kind) {
        case WifiEvent::Kind::Up:
            log_heap("wifi up");
            apply(link_.onWifi(true, now_ms()));
            return;
        case WifiEvent::Kind::Down:
            apply(link_.onWifi(false, now_ms()));
            return;
        case WifiEvent::Kind::Scanned:
            app_.onWifiScan(event.nets);
            return;
        case WifiEvent::Kind::Joined: {
            const std::optional<std::string> error = settings::addWifi(joining_);
            joining_.password.assign(joining_.password.size(), '\0');
            joining_ = {};
            feed(app_.onWifiResult(!error, error.value_or("")));
            return;
        }
        case WifiEvent::Kind::JoinFailed:
            joining_.password.assign(joining_.password.size(), '\0');
            joining_ = {};
            feed(app_.onWifiResult(false, event.text));
            return;
        case WifiEvent::Kind::Status:
            if (link_.state() == t3::Link::State::NoWifi) {
                feed(app_.onLinkStatus(event.text));
            }
            return;
        }
    }

    void onPairDone(const PairDone &done)
    {
        if (!done.error.empty()) {
            ESP_LOGW(TAG, "%s", done.error.c_str());
            feed(app_.onPairResult(std::nullopt, done.error));
            return;
        }
        t3::PairReply reply = t3::parsePairReply(done.status, done.body);
        ESP_LOGI(TAG, "pair: http %d%s", done.status, reply.token ? ", token received" : "");
        if (!reply.token) {
            ESP_LOGW(TAG, "%s", reply.error.c_str());
        }
        feed(app_.onPairResult(std::move(reply.token), reply.error));
    }

    void feed(const t3::App::Out &out)
    {
        if (out.scanWifi) {
            wifi_scan();
        }
        if (out.forgetWifi) {
            const std::optional<std::string> error = settings::removeWifi(*out.forgetWifi);
            app_.onWifiForgotten(*out.forgetWifi, !error, error.value_or(""));
        }
        if (out.joinWifi) {
            joining_ = {out.joinWifi->ssid, out.joinWifi->password};
            wifi_join(out.joinWifi->ssid, out.joinWifi->password, now_ms());
        }
        if (out.pair && !link_.canPair()) {
            feed(app_.onPairResult(std::nullopt, "pairing refused: already paired and connected, pair after the relay asks to re-pair"));
        } else if (out.pair) {
            const std::optional<std::string> body = t3::encodePair(out.pair->code, out.pair->name);
            const std::optional<std::string> error = body ? pair_start(*body) : std::optional<std::string>("out of memory: pair body not built");
            if (error) {
                feed(app_.onPairResult(std::nullopt, *error));
            }
        }
        if (out.storeToken) {
            const std::optional<std::string> error = settings::setToken(*out.storeToken);
            if (!error) {
                link_.setToken(*out.storeToken);
            }
            feed(app_.onTokenStored(!error, error.value_or("")));
        }
        if (out.reconnect) {
            apply(link_.onUserReconnect(now_ms()));
        }
        for (const std::string &frame : out.send) {
            if (const std::optional<std::string> error = transport_send(frame)) {
                ESP_LOGE(TAG, "%s", error->c_str());
                app_.onTransportError(*error);
            }
        }
    }

    t3::App app_;
    t3::Link link_;
    settings::WifiCred joining_;
    std::map<std::string, size_t> largestFrame_;
    bool dirty_ = true;
};

void draw(const t3::App &app)
{
    t3::Grid grid;
    app.draw(grid);
    display_draw(grid);
}

void show_fatal(std::string_view message, std::string_view consequence)
{
    ESP_LOGE(TAG, "%.*s", static_cast<int>(message.size()), message.data());
    t3::Grid grid;
    grid.put(0, 0, "T3", t3::Color::Text);
    int row = 2;
    for (const std::string &line : t3::wrapWords(message, t3::Grid::Cols)) {
        grid.put(row++, 0, line, t3::Color::Red);
    }
    grid.put(row + 1, 0, consequence, t3::Color::Warn);
    display_draw(grid);
}

[[noreturn]] void halt()
{
    debug_serial_start();
    for (;;) {
        vTaskDelay(portMAX_DELAY);
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
    if (const std::optional<std::string> error = settings::init()) {
        show_fatal(*error, "wifi and the token cannot be saved");
        halt();
    }
    const bool keyboard_ok = keyboard_init();
    ESP_LOGI(TAG, "keyboard %s", keyboard_ok ? "ready" : "missing");
    if (!transport_init(settings::relayUrl(), static_cast<size_t>(kCaps.maxFrameBytes))) {
        show_fatal("heap: relay frame buffers do not fit", "the relay link cannot start");
        halt();
    }
    log_heap("transport");
    if (!wifi_init()) {
        show_fatal("wifi: driver init failed", "the relay link cannot start");
        halt();
    }
    log_heap("wifi init");
    const std::optional<std::string> token = settings::token();
    static Device device(kCaps, (static_cast<uint64_t>(esp_random()) << 32) | esp_random(), token.value_or(""));
    device.boot(!settings::wifi().empty(), token.has_value());
    draw(device.app());
    debug_serial_start();
    log_heap("ready");

    for (;;) {
        t3::Key key;
        while (debug_serial_poll_key(&key)) {
            device.key(key);
        }
        while (const std::optional<t3::Key> pressed = keyboard_poll()) {
            device.key(*pressed);
        }
        device.poll();
        if (device.takeDirty()) {
            draw(device.app());
        }
        transport_wait(kMainPollTicks);
    }
}
