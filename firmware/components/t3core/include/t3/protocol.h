#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace t3 {

// receipt: PROTOCOL_VERSION in relay/src/protocol/messages.ts, checked by protocol_test.cpp
inline constexpr int ProtocolVersion = 1;

// receipt: REQUEST_ID_MAX in relay/src/protocol/messages.ts
inline constexpr int kRequestIdMax = 16;
// receipt: REF_MAX in relay/src/protocol/messages.ts (threadId, requestId, projectId, option value, model)
inline constexpr int kRefMax = 128;
// receipt: LABEL_MAX in relay/src/protocol/messages.ts (option label)
inline constexpr int kLabelMax = 64;
// receipt: MODEL_LABEL_MAX in relay/src/protocol/messages.ts (projects.models[].label)
inline constexpr int kModelLabelMax = 24;
// receipt: TOKEN_MAX in relay/src/protocol/messages.ts
inline constexpr int kTokenMax = 256;
// receipt: FW_MAX in relay/src/protocol/messages.ts
inline constexpr int kFwMax = 32;
// receipt: REPLY_TEXT_MAX in relay/src/protocol/messages.ts (reply.text and launch.text)
inline constexpr int kReplyTextMax = 4000;
// receipt: RESPOND_TEXT_MAX in relay/src/protocol/messages.ts
inline constexpr int kRespondTextMax = 1000;
// receipt: COLS_MAX in relay/src/protocol/messages.ts, the widest row the relay can be told to wrap to
inline constexpr int kColsMax = 255;
// receipt: BODY_ROWS_MAX in relay/src/protocol/messages.ts, thread_page.lines and request.lines + options never exceed bodyRows
inline constexpr int kBodyRowsMax = 64;
// receipt: HOME_ROWS_MAX in relay/src/protocol/messages.ts (home.rows and projects.items)
inline constexpr int kHomeRowsMax = 255;
// receipt: FRAME_BYTES_MAX in relay/src/protocol/messages.ts, hello.maxFrameBytes never exceeds it so no relay text frame does
inline constexpr int kFrameBytesMax = 1048576;
// receipt: FRAME_BYTES_MIN in relay/src/protocol/messages.ts
inline constexpr int kFrameBytesMin = 256;
// receipt: REJECTION_TEXT_MAX in relay/src/protocol/messages.ts (error.message)
inline constexpr int kErrorMessageMax = 120;
// receipt: HOME_AGE_COLS in relay/src/protocol/messages.ts
inline constexpr int kHomeAgeCols = 4;
// receipt: docs/receipts/2026-10-21-firmware-network.md "json nesting", 8x the deepest relay frame (projects, 4 levels) at 64 bytes of ADV stack per level; CJSON_NESTING_LIMIT in firmware/CMakeLists.txt and test/host/CMakeLists.txt must match
inline constexpr int kJsonNestingMax = 32;
// receipt: DEVICE_FRAME_BYTES_MAX in relay/src/protocol/messages.ts, also the audio chunk cap
inline constexpr int kDeviceFrameBytesMax = 65536;
// why: the relay has no cap on warnings (relay/src/session.ts clips each to kErrorMessageMax); about 7 conditions can warn at once, so 16 is a tripwire and Home.warningsDropped says how many were cut
inline constexpr int kWarningsMax = 16;
// receipt: docs/protocol.md audio_start, sampleRate must be 16000
inline constexpr int kAudioSampleRate = 16000;

enum class Mode { Queue, Steer };
enum class Workspace { Root, Worktree };
enum class RuntimeMode { ApprovalRequired, AutoAcceptEdits, Auto, FullAccess };
enum class HomeKind { Approval, Question, Failed, Running, Done, Unknown };
enum class RequestKind { Approval, Question };
enum class T3Status { Ok, Unreachable };
enum class ErrorCode { ProtocolVersion, Auth, HelloTimeout, BadMessage, BadAudio, AudioNotStarted, Internal, Unknown };

std::string_view workspaceName(Workspace value);
std::string_view runtimeModeName(RuntimeMode value);
std::string_view modeName(Mode value);

struct HelloCaps {
    int cols;
    int bodyRows;
    int maxFrameBytes;
    int maxHomeRows;
};

struct Welcome {
    int v = 0;
    std::string relay;
};

struct Ack {
    std::string id;
    bool ok = false;
    std::optional<std::string> error;
};

struct HomeRow {
    std::string threadId;
    HomeKind kind = HomeKind::Done;
    std::string project;
    std::string title;
    std::string age;
};

struct HomeCounts {
    int needs = 0;
    int running = 0;
    int done = 0;
};

struct Approvals {
    bool available = false;
    std::optional<std::string> reason;
};

struct Home {
    std::vector<HomeRow> rows;
    HomeCounts counts;
    Approvals approvals;
    std::vector<std::string> warnings;
    int warningsDropped = 0;
    T3Status t3 = T3Status::Ok;
};

struct ThreadHeader {
    std::string project;
    std::string title;
    std::string model;
    std::string status;
};

struct PageTruncated {
    std::string budget;
    int limit = 0;
    int actual = 0;
};

struct ThreadPage {
    std::string threadId;
    ThreadHeader header;
    int page = 1;
    int pages = 1;
    std::vector<std::string> lines;
    std::optional<PageTruncated> truncated;
};

struct Option {
    char key = 0;
    std::string label;
    std::string value;
};

struct Request {
    std::string threadId;
    std::string requestId;
    RequestKind kind = RequestKind::Approval;
    std::vector<std::string> lines;
    std::vector<Option> options;
};

struct ProjectDefaults {
    std::string model;
    Workspace workspace = Workspace::Root;
    RuntimeMode runtimeMode = RuntimeMode::ApprovalRequired;
};

struct ProjectItem {
    std::string projectId;
    std::string name;
    ProjectDefaults defaults;
};

struct ProjectsTruncated {
    std::string budget;
    int limit = 0;
    int actual = 0;
    int hidden = 0;
};

struct ModelOption {
    std::string id;
    std::string label;
};

struct Projects {
    std::vector<ProjectItem> items;
    std::vector<ModelOption> models;
    std::optional<ProjectsTruncated> truncated;
};

struct TranscriptPartial {
    std::string text;
};

struct TranscriptFinal {
    std::string text;
};

struct Error {
    ErrorCode code = ErrorCode::Internal;
    std::string message;
};

using RelayMsg = std::variant<Welcome, Ack, Home, ThreadPage, Request, Projects, TranscriptPartial, TranscriptFinal, Error>;

std::optional<RelayMsg> parseRelay(std::string_view json, const HelloCaps &caps, std::string &err);

struct JsonAllocator {
    void *(*allocate)(size_t);
    void (*release)(void *);
};

void setJsonAllocator(const JsonAllocator &allocator);
void setJsonParseBudget(size_t bytes);

struct LaunchOptions {
    std::optional<std::string> model;
    std::optional<Workspace> workspace;
    std::optional<RuntimeMode> runtimeMode;
};

std::optional<std::string> encodeHello(const HelloCaps &caps, std::string_view token, std::string_view fw);
std::optional<std::string> encodeOpenThread(std::string_view id, std::string_view threadId);
std::optional<std::string> encodePage(std::string_view id, std::string_view threadId, int page);
std::optional<std::string> encodeReply(std::string_view id, std::string_view threadId, std::string_view text, Mode mode);
std::optional<std::string> encodeRespond(std::string_view id, std::string_view threadId, std::string_view requestId, std::string_view value,
                          std::optional<std::string_view> text);
std::optional<std::string> encodeLaunch(std::string_view id, std::string_view projectId, std::string_view text, const LaunchOptions &options);
std::optional<std::string> encodeListProjects(std::string_view id);
std::optional<std::string> encodeRefresh(std::string_view id);
std::optional<std::string> encodeAudioStart(std::string_view id);
std::optional<std::string> encodeAudioEnd(std::string_view id);
std::optional<std::string> encodeAudioCancel(std::string_view id);

std::optional<std::string> encodePair(std::string_view code, std::string_view name);

struct PairReply {
    std::optional<std::string> token;
    std::string error;
};

PairReply parsePairReply(int status, std::string_view body);

class IdGen {
public:
    explicit IdGen(uint64_t seed) : state_(seed) {}
    std::string next();

private:
    uint64_t state_;
};

enum class CloseAction { Reconnect, RePair, UpdateFirmware, UpdateRelay, ShowAndStop };

CloseAction closeAction(int code, std::string_view errorMessage);

}
