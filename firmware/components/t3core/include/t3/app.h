#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "t3/grid.h"
#include "t3/keys.h"
#include "t3/protocol.h"

namespace t3 {

// why: simple visual reaction time is about 200-250 ms, so a key already on its way when an unasked-for request replaces the screen lands inside 400 ms; option keys act only after 400 ms with no typed key
inline constexpr uint32_t kRequestGuardMs = 400;

// receipt: docs/receipts/2026-10-21-firmware-network.md "unacked replies and answers"
inline constexpr int kUnackedMax = 8;
inline constexpr size_t kUnackedBytesMax = 8192;

std::vector<std::string> wrapWords(std::string_view text, int width);

// why: 16-bit PCM spans 96 dB, so -96 dBFS is below any chunk that is not all zeros
inline constexpr int kSilenceDbfs = -96;
int chunkDbfs(const int16_t *samples, size_t count);

struct WifiNet {
    std::string ssid;
    int rssi = 0;
    bool secure = true;
    bool saved = false;
};

struct WifiJoin {
    std::string ssid;
    std::string password;
};

struct PairRequest {
    std::string code;
    std::string name;
};

class App {
public:
    struct Out {
        std::vector<std::string> send;
        enum class Audio { None, Start, Stop, Cancel } audio = Audio::None;
        bool scanWifi = false;
        std::optional<WifiJoin> joinWifi;
        std::optional<std::string> forgetWifi;
        std::optional<PairRequest> pair;
        std::optional<std::string> storeToken;
        std::optional<std::string> relayUrl;
        bool reconnect = false;
        bool pairCodeSpent = false;
    };

    App(const HelloCaps &caps, uint64_t idSeed);

    Out onKey(Key key, uint32_t nowMs);
    Out onWake();
    void onAudio(int dbfs, uint32_t nowMs);
    Out onAudioFailed(std::string_view why);
    Out onRelay(const RelayMsg &msg, uint32_t nowMs);
    Out onFrame(std::string_view json, uint32_t nowMs);
    Out onLinkStatus(std::string_view status, uint32_t nowMs);
    Out onBoot(bool hasWifi, bool hasToken, bool hasRelay);
    void setRelayUrl(std::string https);
    Out onAuthRejected();
    void onDeviceError(std::string_view why);
    void onSendFailed(std::string_view frame, std::string_view why, uint32_t nowMs);
    void onWifiScan(std::vector<WifiNet> nets);
    Out onWifiResult(bool ok, std::string_view why);
    Out startAutoPair(std::string code);
    Out onPairResult(std::optional<std::string> token, std::string_view why, int httpStatus);
    Out onTokenStored(bool ok, std::string_view why);
    void onWifiForgotten(std::string_view ssid, bool ok, std::string_view why);
    void draw(Grid &grid) const;
    std::string_view screenName() const;
    bool editing() const;
    bool recording() const;

private:
    enum class Screen { Connecting, Home, Thread, Request, Projects, Prompt, SetupWifiList, SetupWifiSsid, SetupWifiPassword, SetupPair, SetupRelay, Voice };
    enum class Voice { Recording, Transcribing, Review };
    enum class Field { None, Model, Workspace, Mode };
    enum class GiveBack { Refused, NotSent, Unconfirmed };

    struct Line {
        std::string text;
        Color color = Color::Text;
        int row = -1;
    };

    struct Unacked {
        std::string id;
        std::string threadId;
        std::string text;
        std::string confirmed;
        Mode mode = Mode::Queue;
        std::optional<Request> request;
        std::optional<Option> option;
    };

    struct Unsent {
        std::string threadId;
        std::string text;
        std::optional<std::string> requestId;
        std::optional<Option> option;
    };

    struct RequestLayout {
        std::vector<Line> scroll;
        std::vector<Line> pinned;
        int scrollRows = 0;
    };

    std::string nextId() { return ids_.next(); }
    bool send(Out &out, std::optional<std::string> frame, std::string_view what);
    bool readyToSend(std::string_view what);
    bool sendTracked(Out &out, std::string_view what, Unacked item);
    static size_t sizeOf(const Unacked &item);
    static size_t sizeOf(const Unsent &item);
    size_t unackedBytes() const;
    size_t unsentBytes() const;
    std::string dropOldestUnsent(size_t excess);
    void dropAnswersNoLongerPending();
    std::string giveBack(const Unacked &item, GiveBack outcome, std::string_view why, uint32_t nowMs);
    bool keep(const Unacked &item);
    bool takeReply();
    void inform(std::string text, Color color = Color::Red);
    void inform(const std::vector<std::string> &notes, Color color);
    void informAlso(const std::vector<std::string> &notes, Color color);
    Out dropLink(std::vector<std::string> &notes, Color &color);
    std::string dropUnacked();
    void type(std::string &text, char c, int max, std::string_view budget, std::string_view what);
    Out refresh();
    std::string health() const;
    const HomeRow *homeRow(std::string_view threadId) const;
    void drawBar(Grid &grid, std::string_view left, std::string_view right, Color rightColor = Color::Text) const;
    static void drawHint(Grid &grid, std::string_view hint);
    void onAck(const Ack &ack, uint32_t nowMs);
    void onRequest(const Request &request, uint32_t nowMs);
    bool enterRequest(const Request &request, uint32_t nowMs);
    void showRequest(const Request &request);
    std::string threadTitle(std::string_view threadId) const;

    void onHome(const Home &home);
    Out homeKey(Key key);
    std::vector<Line> homeLines() const;
    int homeSelectedLine(const std::vector<Line> &lines) const;
    void showHomeSelection();
    void drawHome(Grid &grid) const;

    Out openThread(std::string threadId);
    Out threadKey(Key key);
    Out showWaiting();
    void drawThread(Grid &grid) const;

    Out requestKey(Key key, uint32_t nowMs);
    RequestLayout requestLayout() const;
    Out respond(Option option, std::optional<std::string> text);
    void drawRequest(Grid &grid) const;

    Out listProjects();
    Out projectsKey(Key key);
    Out promptKey(Key key);
    void drawProjects(Grid &grid) const;
    void drawPrompt(Grid &grid) const;

    Out openSetup();
    void leaveSetup();
    Out showWifiList();
    Out wifiListKey(Key key);
    Out wifiSsidKey(Key key);
    Out wifiPasswordKey(Key key);
    Out pairKey(Key key);
    Out relayKey(Key key);
    void drawSetupBar(Grid &grid, std::string_view step) const;
    void drawWifiList(Grid &grid) const;
    void drawWifiSsid(Grid &grid) const;
    void drawWifiPassword(Grid &grid) const;
    void drawPair(Grid &grid) const;
    void drawRelay(Grid &grid) const;

    Out startVoice(uint32_t nowMs);
    Out stopVoice(uint32_t nowMs);
    Out cancelRecording(std::string_view why);
    void leaveVoice();
    bool commitVoice();
    Out voiceKey(Key key, uint32_t nowMs);
    Out onAudioAck(const Ack &ack);
    std::optional<Out> onAudioError(const Error &error);
    Out onVoiceLinkLost(std::string &lost);
    void onTranscript(std::string_view text);
    void drawVoice(Grid &grid) const;

    HelloCaps caps_;
    IdGen ids_;
    Screen screen_ = Screen::Connecting;
    std::string linkStatus_ = "starting";
    std::string notice_;
    Color noticeColor_ = Color::Red;

    std::optional<Home> home_;
    int homeSelected_ = 0;
    int homeTop_ = 0;

    std::string threadId_;
    std::optional<ThreadPage> page_;
    std::string reply_;
    std::string openId_;
    std::vector<Unacked> unacked_;
    std::vector<Unsent> unsent_;

    std::optional<Request> request_;
    std::optional<Request> waiting_;
    std::optional<uint32_t> guardSinceMs_;
    int requestTop_ = 0;
    std::optional<Option> typingFor_;
    std::string answer_;

    std::optional<Projects> projects_;
    int projectSelected_ = 0;
    int projectTop_ = 0;
    std::string prompt_;
    int modelStop_ = 0;
    Workspace workspace_ = Workspace::Root;
    RuntimeMode mode_ = RuntimeMode::ApprovalRequired;
    Field field_ = Field::None;
    std::string launchId_;

    bool hasToken_ = false;
    std::vector<WifiNet> nets_;
    bool scanned_ = false;
    int netSelected_ = 0;
    int netTop_ = 0;
    WifiNet joinTarget_;
    bool joinTyped_ = false;
    std::string typedSsid_;
    std::string wifiPassword_;
    bool joining_ = false;
    std::string pairCode_;
    std::string pairNote_;
    bool pairing_ = false;
    bool autoPairing_ = false;
    bool hasRelay_ = false;
    std::string relayUrl_;
    std::string relayText_;

    Screen voiceFrom_ = Screen::Thread;
    Voice voice_ = Voice::Review;
    std::string voiceText_;
    std::string voicePartial_;
    std::string audioStartId_;
    std::string audioEndId_;
    uint32_t recStartMs_ = 0;
    uint32_t recMs_ = 0;
    std::string meter_;
};

}
