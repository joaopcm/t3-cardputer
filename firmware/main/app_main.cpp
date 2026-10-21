#include <algorithm>
#include <cstdio>
#include <cstdlib>
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
#include "mic.h"
#include "power.h"
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
// receipt: docs/receipts/2026-10-21-firmware-network.md "json parse budget", 1.46x the ADV's honest worst parse (4.1 x 8192 = 33.6 KB), about 70 KB at the cap leaves about 63 KB of the live heap
constexpr size_t kJsonParseBudgetBytes = 49152;

// receipt: docs/receipts/2026-10-21-firmware-voice.md "send", 6x the home WiFi send max (48 ms) and inside the 300 ms the mic buffer holds; retune at Checkpoint B
constexpr uint32_t kAudioSendWaitMs = 300;
static_assert(kAudioSendWaitMs <= kMicBufferMs);

// receipt: docs/receipts/2026-10-21-firmware-voice.md "tail", the chunk in flight at talk-up finishes within one chunk period, 2x is the tripwire
constexpr uint32_t kTailWaitMs = 2 * kMicChunkMs;

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

struct VoiceStats {
    uint32_t startMs = 0;
    uint32_t lastSendMs = 0;
    uint32_t firstSoundMs = 0;
    uint32_t chunks = 0;
    uint32_t bytes = 0;
    uint32_t maxSendMs = 0;
    uint32_t maxGapMs = 0;
    int minDbfs = 0;
    int maxDbfs = t3::kSilenceDbfs;
    int peak = 0;
};

int peakOf(const int16_t *samples, size_t count)
{
    int peak = 0;
    for (size_t i = 0; i < count; ++i) {
        peak = std::max(peak, std::abs(static_cast<int>(samples[i])));
    }
    return peak;
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
        const t3::Power::KeyEffect effect = power_on_key(key.name, now_ms());
        if (effect != t3::Power::KeyEffect::Deliver) {
            wake();
        }
        if (effect == t3::Power::KeyEffect::Woke) {
            ESP_LOGI(TAG, "woke, key not delivered");
            return;
        }
        ESP_LOGI(TAG, "key %s", loggedKey(key).c_str());
        feed(app_.onKey(key, now_ms()));
        ESP_LOGI(TAG, "screen %.*s", static_cast<int>(app_.screenName().size()), app_.screenName().data());
        dirty_ = true;
    }

    void wake()
    {
        feed(app_.onWake());
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
            app_.onDeviceError(*dropped);
            dirty_ = true;
        }
        if (std::optional<PairDone> done = pair_poll()) {
            onPairDone(*done);
            dirty_ = true;
        }
        uint32_t dimAfterMs;
        uint32_t offAfterMs;
        if (debug_serial_poll_power(&dimAfterMs, &offAfterMs)) {
            power_set_timeouts(dimAfterMs, offAfterMs, now_ms());
        }
        power_tick(now_ms(), app_.editing(), app_.recording());
        const bool dark = power_level() == t3::Power::Level::Off;
        if (dark != dark_) {
            dark_ = dark;
            dark ? mic_power_down() : mic_power_up();
        }
        mic_tick();
        switch (debug_serial_poll_net_cut()) {
        case DebugNetCut::None:
            break;
        case DebugNetCut::LeaveAp:
            ESP_LOGI(TAG, "debug: leaving the access point");
            wifi_debug_leave_ap();
            break;
        case DebugNetCut::BlackHole:
            ESP_LOGI(TAG, "debug: dropping every outgoing packet");
            wifi_debug_black_hole(true);
            break;
        case DebugNetCut::Restore:
            ESP_LOGI(TAG, "debug: sending packets again");
            wifi_debug_black_hole(false);
            break;
        }
        if (debug_serial_poll_drop()) {
            ESP_LOGI(TAG, "debug: dropping the relay socket");
            transport_close();
            apply(link_.onClose(kAbnormalClose, "debug drop", now_ms()));
            dirty_ = true;
        }
        apply(link_.onTick(now_ms()));
    }

    void pumpAudio()
    {
        if (!app_.recording()) {
            endRecording("abandoned");
            return;
        }
        if (const size_t count = mic_read(chunk_, kMicChunkSamples); count > 0 && !sendChunk(count)) {
            return;
        }
        if (std::optional<std::string> lost = mic_lost()) {
            ESP_LOGE(TAG, "%s", lost->c_str());
            app_.onDeviceError("voice: " + *lost);
            dirty_ = true;
        }
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

    void startRecording()
    {
        if (std::optional<std::string> error = mic_start()) {
            ESP_LOGE(TAG, "%s", error->c_str());
            feed(app_.onAudioFailed(*error));
            return;
        }
        voice_ = VoiceStats{};
        voice_.startMs = now_ms();
        voice_.lastSendMs = voice_.startMs;
        micOn_ = true;
        log_heap("mic on");
    }

    bool finishRecording()
    {
        bool sent = true;
        while (sent) {
            const size_t count = mic_read(chunk_, kMicChunkSamples);
            if (count == 0) {
                break;
            }
            sent = sendChunk(count);
        }
        if (const size_t tail = sent ? mic_read(chunk_, kMicChunkSamples, kTailWaitMs) : 0) {
            sent = sendChunk(tail);
        }
        endRecording(sent ? "sent" : "cut short");
        return sent;
    }

    void endRecording(const char *how)
    {
        if (!micOn_) {
            return;
        }
        micOn_ = false;
        mic_stop();
        const uint32_t elapsed = std::max<uint32_t>(1, now_ms() - voice_.startMs);
        ESP_LOGI(TAG,
                 "voice %s: %u chunks %u bytes in %u ms = %u B/s, send max %u ms, gap max %u ms, rms %d..%d dBFS, peak %d, first sound %u ms",
                 how, static_cast<unsigned>(voice_.chunks), static_cast<unsigned>(voice_.bytes), static_cast<unsigned>(elapsed),
                 static_cast<unsigned>(static_cast<uint64_t>(voice_.bytes) * 1000 / elapsed), static_cast<unsigned>(voice_.maxSendMs),
                 static_cast<unsigned>(voice_.maxGapMs), voice_.minDbfs, voice_.maxDbfs, voice_.peak, static_cast<unsigned>(voice_.firstSoundMs));
    }

    bool sendChunk(size_t count)
    {
        const uint32_t before = now_ms();
        if (std::optional<AudioSendError> error = transport_send_audio(chunk_, count, kAudioSendWaitMs)) {
            ESP_LOGE(TAG, "%s", error->text.c_str());
            dirty_ = true;
            if (error->kind == AudioSendError::Kind::NotConnected) {
                // why: the socket's own close is already queued and carries the real code (4000 must stop, 4401 must re-pair); it ends the recording as `voice: connection lost` on the next pass
                return false;
            }
            // why: a socket that holds a send past the mic buffer has stopped carrying audio, and nothing else will close it until the ping times out; a blocked send froze the main loop for the 5 s text timeout (docs/receipts/2026-10-21-firmware-voice.md "link lost while talking")
            transport_close();
            apply(link_.onClose(kAbnormalClose, error->text, now_ms()));
            return false;
        }
        const uint32_t after = now_ms();
        const int dbfs = t3::chunkDbfs(chunk_, count);
        if (voice_.firstSoundMs == 0 && dbfs > t3::kSilenceDbfs) {
            voice_.firstSoundMs = after - voice_.startMs;
        }
        voice_.chunks += 1;
        voice_.bytes += count * sizeof(int16_t);
        voice_.maxSendMs = std::max(voice_.maxSendMs, after - before);
        voice_.maxGapMs = std::max(voice_.maxGapMs, after - voice_.lastSendMs);
        voice_.lastSendMs = after;
        voice_.minDbfs = std::min(voice_.minDbfs, dbfs);
        voice_.maxDbfs = std::max(voice_.maxDbfs, dbfs);
        voice_.peak = std::max(voice_.peak, peakOf(chunk_, count));
        app_.onAudio(dbfs, after);
        dirty_ = true;
        return true;
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
        if (out.audio == t3::App::Out::Audio::Stop && !finishRecording()) {
            // why: the link is already gone, so audio_end would only fail and its notice would replace `voice: connection lost, transcript lost`
            return;
        }
        if (out.audio == t3::App::Out::Audio::Cancel) {
            endRecording("cancelled");
        }
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
        if (const std::optional<std::string> refused = out.pair ? link_.pairRefused() : std::nullopt) {
            feed(app_.onPairResult(std::nullopt, *refused));
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
        std::optional<std::string> sendError;
        for (const std::string &frame : out.send) {
            if (std::optional<std::string> error = transport_send(frame)) {
                ESP_LOGE(TAG, "%s", error->c_str());
                app_.onSendFailed(frame, *error, now_ms());
                sendError = std::move(error);
            }
        }
        if (out.audio == t3::App::Out::Audio::Start) {
            if (sendError) {
                feed(app_.onAudioFailed(*sendError));
            } else {
                startRecording();
            }
        }
    }

    t3::App app_;
    t3::Link link_;
    settings::WifiCred joining_;
    std::map<std::string, size_t> largestFrame_;
    int16_t chunk_[kMicChunkSamples];
    VoiceStats voice_;
    bool micOn_ = false;
    bool dark_ = true;
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
    const settings::Init nvs = settings::init();
    if (nvs.error) {
        show_fatal(*nvs.error, "wifi and the token cannot be saved");
        halt();
    }
    const std::optional<std::string> keyboardError = keyboard_init();
    ESP_LOGI(TAG, "keyboard %s", keyboardError ? keyboardError->c_str() : "ready");
    if (!transport_init(T3_RELAY_URL, static_cast<size_t>(kCaps.maxFrameBytes))) {
        show_fatal("heap: relay frame buffers do not fit", "the relay link cannot start");
        halt();
    }
    log_heap("transport");
    if (!wifi_init()) {
        show_fatal("wifi: driver init failed", "the relay link cannot start");
        halt();
    }
    log_heap("wifi init");
    t3::setJsonParseBudget(kJsonParseBudgetBytes);
    const std::optional<std::string> token = settings::token();
    static Device device(kCaps, (static_cast<uint64_t>(esp_random()) << 32) | esp_random(), token.value_or(""));
    device.boot(!settings::wifi().empty(), token.has_value());
    for (const std::optional<std::string> &fault : {nvs.erased, keyboardError}) {
        if (fault) {
            device.app().onDeviceError(*fault);
        }
    }
    power_init(now_ms());
    draw(device.app());
    const bool mic_ok = mic_init(system_i2c_bus());
    ESP_LOGI(TAG, "mic %s", mic_ok ? "ready" : "missing");
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
        device.pumpAudio();
        if (device.takeDirty()) {
            draw(device.app());
        }
        transport_wait(kMainPollTicks);
    }
}
