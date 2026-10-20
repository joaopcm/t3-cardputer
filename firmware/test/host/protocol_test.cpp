#include "doctest.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <malloc.h>
#include <new>
#include <regex>
#include <set>
#include <sstream>
#include <string>

#include "cJSON.h"
#include "t3/protocol.h"

namespace {

struct JsonDeleter {
    void operator()(cJSON *json) const { cJSON_Delete(json); }
};
using JsonPtr = std::unique_ptr<cJSON, JsonDeleter>;

JsonPtr parseJson(const std::string &text)
{
    return JsonPtr(cJSON_Parse(text.c_str()));
}

const t3::HelloCaps kCaps{40, 11, 4096, 8};

bool sameJson(const std::optional<std::string> &actual, const std::string &expected)
{
    if (!actual) {
        return false;
    }
    const JsonPtr a = parseJson(*actual);
    const JsonPtr b = parseJson(expected);
    return a && b && cJSON_Compare(a.get(), b.get(), true);
}

template <typename T>
T parseAs(const std::string &json)
{
    static std::optional<t3::RelayMsg> keep;
    std::string err;
    keep = t3::parseRelay(json, kCaps, err);
    REQUIRE_MESSAGE(keep.has_value(), err);
    const T *msg = std::get_if<T>(&*keep);
    REQUIRE(msg != nullptr);
    return *msg;
}

std::string parseError(const std::string &json)
{
    std::string err;
    const auto msg = t3::parseRelay(json, kCaps, err);
    CHECK_FALSE(msg.has_value());
    return err;
}

std::string readFile(const std::string &path)
{
    std::ifstream in(path);
    REQUIRE_MESSAGE(in.good(), path);
    std::stringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

long messagesConstant(const std::string &source, const std::string &name)
{
    const std::regex pattern("export const " + name + " = ([0-9_]+);");
    std::smatch match;
    REQUIRE_MESSAGE(std::regex_search(source, match, pattern), name);
    std::string digits = match[1];
    digits.erase(std::remove(digits.begin(), digits.end(), '_'), digits.end());
    return std::stol(digits);
}

const char *kHome =
    R"({"type":"home","rows":[{"threadId":"thr_01","kind":"approval","project":"api","title":"run migration","age":"42s"},{"threadId":"thr_02","kind":"running","project":"web","title":"fix flaky test","age":"5m"}],"counts":{"needs":1,"running":1,"done":6},"approvals":{"available":false,"reason":"approvals off"},"warnings":["T3 slow"],"t3":"unreachable"})";

}

TEST_CASE("home parses into typed rows, counts, approvals, warnings and t3 state")
{
    const auto home = parseAs<t3::Home>(kHome);
    REQUIRE(home.rows.size() == 2);
    CHECK(home.rows[0].threadId == "thr_01");
    CHECK(home.rows[0].kind == t3::HomeKind::Approval);
    CHECK(home.rows[0].project == "api");
    CHECK(home.rows[0].title == "run migration");
    CHECK(home.rows[0].age == "42s");
    CHECK(home.rows[1].kind == t3::HomeKind::Running);
    CHECK(home.counts.needs == 1);
    CHECK(home.counts.running == 1);
    CHECK(home.counts.done == 6);
    CHECK_FALSE(home.approvals.available);
    CHECK(home.approvals.reason == "approvals off");
    REQUIRE(home.warnings.size() == 1);
    CHECK(home.warnings[0] == "T3 slow");
    CHECK(home.t3 == t3::T3Status::Unreachable);
}

TEST_CASE("welcome, ack, transcripts and error parse")
{
    CHECK(parseAs<t3::Welcome>(R"({"type":"welcome","v":1,"relay":"0.1.0"})").relay == "0.1.0");

    const auto failed = parseAs<t3::Ack>(R"({"type":"ack","id":"a1","ok":false,"error":"thread not found"})");
    CHECK(failed.id == "a1");
    CHECK_FALSE(failed.ok);
    CHECK(failed.error == "thread not found");

    const auto good = parseAs<t3::Ack>(R"({"type":"ack","id":"a1","ok":true})");
    CHECK(good.ok);
    CHECK_FALSE(good.error.has_value());

    CHECK(parseAs<t3::TranscriptPartial>(R"({"type":"transcript_partial","text":"fix the"})").text == "fix the");
    CHECK(parseAs<t3::TranscriptFinal>(R"({"type":"transcript_final","text":"fix the flaky test"})").text == "fix the flaky test");

    const auto error = parseAs<t3::Error>(R"({"type":"error","code":"protocol_version","message":"update relay: device protocol v=2, relay v=1"})");
    CHECK(error.code == t3::ErrorCode::ProtocolVersion);
    CHECK(error.message == "update relay: device protocol v=2, relay v=1");
}

TEST_CASE("thread_page, request and projects parse including the optional truncation objects")
{
    const auto page = parseAs<t3::ThreadPage>(
        R"({"type":"thread_page","threadId":"thr_02","header":{"project":"web","title":"fix","model":"m","status":"done"},"page":32,"pages":32,"lines":["a","b"],"truncated":{"budget":"max_reply_pages","limit":32,"actual":57}})");
    CHECK(page.header.status == "done");
    CHECK(page.page == 32);
    CHECK(page.lines.size() == 2);
    REQUIRE(page.truncated.has_value());
    CHECK(page.truncated->budget == "max_reply_pages");
    CHECK(page.truncated->limit == 32);
    CHECK(page.truncated->actual == 57);

    const auto request = parseAs<t3::Request>(
        R"({"type":"request","threadId":"t","requestId":"r","kind":"question","lines":["Which?"],"options":[{"key":"1","label":"staging","value":"staging"},{"key":"T","label":"Type answer","value":"text"}]})");
    CHECK(request.kind == t3::RequestKind::Question);
    REQUIRE(request.options.size() == 2);
    CHECK(request.options[0].key == '1');
    CHECK(request.options[1].value == "text");

    const auto projects = parseAs<t3::Projects>(
        R"({"type":"projects","items":[{"projectId":"p","name":"api","defaults":{"model":"m","workspace":"worktree","runtimeMode":"auto-accept-edits"}}],"truncated":{"budget":"maxHomeRows","limit":2,"actual":40,"hidden":38}})");
    REQUIRE(projects.items.size() == 1);
    CHECK(projects.items[0].defaults.workspace == t3::Workspace::Worktree);
    CHECK(projects.items[0].defaults.runtimeMode == t3::RuntimeMode::AutoAcceptEdits);
    REQUIRE(projects.truncated.has_value());
    CHECK(projects.truncated->hidden == 38);
}

TEST_CASE("unknown optional fields are ignored")
{
    const auto ack = parseAs<t3::Ack>(R"({"type":"ack","id":"a1","ok":true,"future":{"x":[1,2]}})");
    CHECK(ack.ok);
    const auto row = parseAs<t3::Home>(
        R"({"type":"home","rows":[{"threadId":"t","kind":"done","project":"p","title":"t","age":"1m","badge":"new"}],"counts":{"needs":0,"running":0,"done":1,"later":4},"approvals":{"available":true,"hint":"x"},"warnings":[],"t3":"ok","extra":1})");
    CHECK(row.rows.size() == 1);
}

TEST_CASE("projects models parse, are optional, and name the budget they break")
{
    const auto without = parseAs<t3::Projects>(R"({"type":"projects","items":[]})");
    CHECK(without.models.empty());

    const auto with = parseAs<t3::Projects>(
        R"({"type":"projects","items":[],"models":[{"id":"claude-opus-5-5","label":"opus-5-5"},{"id":"claude-haiku-5-5","label":"haiku-5-5"}]})");
    REQUIRE(with.models.size() == 2);
    CHECK(with.models[0].id == "claude-opus-5-5");
    CHECK(with.models[0].label == "opus-5-5");
    CHECK(with.models[1].label == "haiku-5-5");

    CHECK(parseError(R"({"type":"projects","items":[],"models":[{"id":"m","label":"abcdefghijklmnopq"}]})") == "models[0].label: model_label_max=16, got 17");
    CHECK(parseError(R"({"type":"projects","items":[],"models":[{"id":"m"}]})") == "models[0].label");
    CHECK(parseError(R"({"type":"projects","items":[],"models":"opus"})") == "models: expected array");
}

TEST_CASE("missing required field names its path")
{
    CHECK(parseError(R"({"type":"home","rows":[],"counts":{"needs":0,"running":0},"approvals":{"available":true},"warnings":[],"t3":"ok"})") == "counts.done");
    CHECK(parseError(R"({"type":"home","rows":[{"threadId":"a","kind":"done","project":"p","title":"t","age":"1m"},{"threadId":"b","kind":"done","project":"p","age":"1m"}],"counts":{"needs":0,"running":0,"done":2},"approvals":{"available":true},"warnings":[],"t3":"ok"})") == "rows[1].title");
    CHECK(parseError(R"({"type":"home","rows":[],"counts":{"needs":0,"running":0,"done":0},"approvals":{},"warnings":[],"t3":"ok"})") == "approvals.available");
    CHECK(parseError(R"({"type":"thread_page","threadId":"t","header":{"project":"p","title":"t","model":"m"},"page":1,"pages":1,"lines":[]})") == "header.status");
    CHECK(parseError(R"({"type":"request","threadId":"t","requestId":"r","kind":"approval","lines":[],"options":[{"key":"Y","value":"allow_once"}]})") == "options[0].label");
    CHECK(parseError(R"({"type":"projects","items":[{"projectId":"p","name":"n","defaults":{"model":"m","workspace":"root"}}]})") == "items[0].defaults.runtimeMode");
    CHECK(parseError(R"({"type":"ack","ok":true})") == "id");
    CHECK(parseError(R"({"type":"welcome","relay":"0.1.0"})") == "v");
    CHECK(parseError(R"({"v":1})") == "type");
}

TEST_CASE("wrong types, unknown values and bad frames are named")
{
    CHECK(parseError(R"({"type":"ack","id":"a","ok":"yes"})") == "ok: expected boolean");
    CHECK(parseError(R"({"type":"ack","id":5,"ok":true})") == "id: expected string");
    CHECK(parseError(R"({"type":"thread_page","threadId":"t","header":{"project":"p","title":"t","model":"m","status":"s"},"page":1.5,"pages":1,"lines":[]})") == "page: expected integer");
    CHECK(parseError(R"({"type":"thread_page","threadId":"t","header":{"project":"p","title":"t","model":"m","status":"s"},"page":0,"pages":1,"lines":[]})") == "page: min=1, got 0");
    CHECK(parseError(R"({"type":"thread_page","threadId":"t","header":{"project":"p","title":"t","model":"m","status":"s"},"page":1,"pages":1,"lines":[3]})") == "lines[0]: expected string");
    CHECK(parseError(R"({"type":"nope"})") == "type: unknown 'nope'");
    CHECK(parseError(R"({"type":"request","threadId":"t","requestId":"r","kind":"maybe","lines":[],"options":[]})") == "kind: unknown 'maybe'");
    CHECK(parseError("[1,2]") == "message: expected object");
    CHECK_FALSE(parseError("{not json").empty());
    CHECK_FALSE(parseError("").empty());
}

TEST_CASE("parser limits name the budget, the limit and the ask")
{
    CHECK(parseError(R"({"type":"ack","id":"12345678901234567","ok":true})") == "id: request_id_max=16, got 17");
    CHECK(parseError(R"({"type":"ack","id":"","ok":true})") == "id: min_chars=1, got 0");

    std::string tooManyLines = R"({"type":"thread_page","threadId":"t","header":{"project":"p","title":"t","model":"m","status":"s"},"page":1,"pages":1,"lines":[)";
    for (int i = 0; i < 12; ++i) {
        tooManyLines += i == 0 ? "\"x\"" : ",\"x\"";
    }
    tooManyLines += "]}";
    CHECK(parseError(tooManyLines) == "lines: body_rows=11, got 12");

    const std::string wide(41, 'x');
    CHECK(parseError(R"({"type":"request","threadId":"t","requestId":"r","kind":"approval","lines":[")" + wide + R"("],"options":[]})") ==
          "lines[0]: cols=40, got 41");
    CHECK(parseError(R"({"type":"request","threadId":"t","requestId":"r","kind":"approval","lines":[],"options":[{"key":"YN","label":"a","value":"v"}]})") ==
          "options[0].key: key_chars=1, got 2");
    CHECK(parseError(R"({"type":"request","threadId":"t","requestId":"r","kind":"approval","lines":[],"options":[{"key":"Y","label":")" + std::string(65, 'l') + R"(","value":"v"}]})") ==
          "options[0].label: label_max=64, got 65");
    CHECK(parseError(R"({"type":"error","code":"internal","message":")" + std::string(121, 'm') + R"("})") == "message: error_message_max=120, got 121");
}

TEST_CASE("the device's declared caps bound the frame and every array")
{
    const std::string oversize = R"({"type":"transcript_final","text":")" + std::string(4096, 'a') + R"("})";
    CHECK(parseError(oversize) == "frame: max_frame_bytes=4096, got " + std::to_string(oversize.size()));

    std::string rows;
    for (int i = 0; i < 9; ++i) {
        rows += std::string(i == 0 ? "" : ",") + R"({"threadId":"t","kind":"done","project":"p","title":"t","age":"1m"})";
    }
    CHECK(parseError(R"({"type":"home","rows":[)" + rows + R"(],"counts":{"needs":0,"running":0,"done":9},"approvals":{"available":true},"warnings":[],"t3":"ok"})") ==
          "rows: max_home_rows=8, got 9");

    CHECK(parseError(R"({"type":"home","rows":[{"threadId":"t","kind":"done","project":")" + std::string(41, 'p') +
                     R"(","title":"t","age":"1m"}],"counts":{"needs":0,"running":0,"done":1},"approvals":{"available":true},"warnings":[],"t3":"ok"})") ==
          "rows[0].project: cols=40, got 41");

    std::string items;
    for (int i = 0; i < 9; ++i) {
        items += std::string(i == 0 ? "" : ",") + R"({"projectId":"p","name":"n","defaults":{"model":"m","workspace":"root","runtimeMode":"auto"}})";
    }
    CHECK(parseError(R"({"type":"projects","items":[)" + items + "]}") == "items: max_home_rows=8, got 9");

    std::string options;
    for (int i = 0; i < 6; ++i) {
        options += std::string(i == 0 ? "" : ",") + R"({"key":"1","label":"a","value":"v"})";
    }
    const std::string tall = R"({"type":"request","threadId":"t","requestId":"r","kind":"question","lines":["1","2","3","4","5","6"],"options":[)" + options + "]}";
    std::string tallErr;
    const auto tallRequest = t3::parseRelay(tall, kCaps, tallErr);
    REQUIRE_MESSAGE(tallRequest.has_value(), tallErr);
    CHECK(std::get<t3::Request>(*tallRequest).options.size() == 6);

    std::string tooManyOptions;
    for (int i = 0; i <= t3::kBodyRowsMax; ++i) {
        tooManyOptions += std::string(i == 0 ? "" : ",") + R"({"key":"1","label":"a","value":"v"})";
    }
    t3::HelloCaps roomy = kCaps;
    roomy.maxFrameBytes = 65536;
    std::string roomyErr;
    CHECK_FALSE(t3::parseRelay(R"({"type":"request","threadId":"t","requestId":"r","kind":"question","lines":[],"options":[)" + tooManyOptions + "]}", roomy, roomyErr)
                    .has_value());
    CHECK(roomyErr == "options: body_rows_max=64, got 65");

    t3::HelloCaps small = kCaps;
    small.maxFrameBytes = 64;
    std::string err;
    CHECK_FALSE(t3::parseRelay(R"({"type":"transcript_final","text":"fix the flaky test in the auth module, please"})", small, err).has_value());
    CHECK(err.rfind("frame: max_frame_bytes=64, got ", 0) == 0);
}

TEST_CASE("warnings past the tripwire are dropped and counted, not rejected")
{
    std::string warnings;
    for (int i = 0; i < 20; ++i) {
        warnings += std::string(i == 0 ? "" : ",") + "\"w" + std::to_string(i) + "\"";
    }
    const auto home = parseAs<t3::Home>(R"({"type":"home","rows":[],"counts":{"needs":0,"running":0,"done":0},"approvals":{"available":true},"warnings":[)" + warnings +
                                        R"(],"t3":"ok"})");
    CHECK(home.warnings.size() == static_cast<size_t>(t3::kWarningsMax));
    CHECK(home.warnings[0] == "w0");
    CHECK(home.warningsDropped == 20 - t3::kWarningsMax);

    CHECK(parseAs<t3::Home>(kHome).warningsDropped == 0);
    CHECK(parseError(R"({"type":"home","rows":[],"counts":{"needs":0,"running":0,"done":0},"approvals":{"available":true},"warnings":[")" + std::string(121, 'w') +
                     R"("],"t3":"ok"})") == "warnings[0]: error_message_max=120, got 121");
}

TEST_CASE("unknown error codes and home kinds keep the frame")
{
    const auto error = parseAs<t3::Error>(R"({"type":"error","code":"quota_exceeded","message":"slow down"})");
    CHECK(error.code == t3::ErrorCode::Unknown);
    CHECK(error.message == "slow down");

    const auto home = parseAs<t3::Home>(
        R"({"type":"home","rows":[{"threadId":"a","kind":"sleeping","project":"p","title":"t","age":"1m"},{"threadId":"b","kind":"done","project":"p","title":"t","age":"1m"}],"counts":{"needs":0,"running":0,"done":2},"approvals":{"available":true},"warnings":[],"t3":"ok"})");
    REQUIRE(home.rows.size() == 2);
    CHECK(home.rows[0].kind == t3::HomeKind::Unknown);
    CHECK(home.rows[0].threadId == "a");
    CHECK(home.rows[1].kind == t3::HomeKind::Done);

    CHECK(parseError(R"({"type":"error","message":"x"})") == "code");
    CHECK(parseError(R"({"type":"error","code":5,"message":"x"})") == "code: expected string");
}

TEST_CASE("4401 maps to RePair and nothing else does")
{
    CHECK(t3::closeAction(4401, "") == t3::CloseAction::RePair);
    for (int code : {1000, 1001, 1006, 1009, 1011, 4000, 4400, 4402, 4408, 4500, 0, -1}) {
        CHECK_MESSAGE(t3::closeAction(code, "update firmware: x") != t3::CloseAction::RePair, code);
    }
}

TEST_CASE("4400 update relay maps to UpdateRelay and update firmware to UpdateFirmware")
{
    CHECK(t3::closeAction(4400, "update relay: device protocol v=2, relay v=1") == t3::CloseAction::UpdateRelay);
    CHECK(t3::closeAction(4400, "update firmware: device protocol v=1, relay v=2") == t3::CloseAction::UpdateFirmware);
    CHECK(t3::closeAction(4400, "something else") == t3::CloseAction::ShowAndStop);
    CHECK(t3::closeAction(4400, "") == t3::CloseAction::ShowAndStop);
}

TEST_CASE("the other close codes follow the table in docs/protocol.md")
{
    CHECK(t3::closeAction(4402, "bad hello") == t3::CloseAction::ShowAndStop);
    CHECK(t3::closeAction(4000, "") == t3::CloseAction::ShowAndStop);
    CHECK(t3::closeAction(4408, "") == t3::CloseAction::Reconnect);
    CHECK(t3::closeAction(1006, "") == t3::CloseAction::Reconnect);
    CHECK(t3::closeAction(1000, "") == t3::CloseAction::Reconnect);
    CHECK(t3::closeAction(1012, "") == t3::CloseAction::Reconnect);
}

TEST_CASE("ids are 16 hex chars and a retry gets a new id")
{
    t3::IdGen ids(0x1234abcd);
    const std::string first = ids.next();
    const std::string retry = ids.next();
    CHECK(first.size() == 16);
    CHECK(retry.size() == 16);
    CHECK(first != retry);
    for (char c : first + retry) {
        CHECK(std::string("0123456789abcdef").find(c) != std::string::npos);
    }
}

TEST_CASE("ids never repeat within a boot and differ across seeds")
{
    t3::IdGen ids(42);
    std::set<std::string> seen;
    for (int i = 0; i < 100000; ++i) {
        CHECK(seen.insert(ids.next()).second);
    }
    t3::IdGen same(42);
    t3::IdGen other(43);
    CHECK(same.next() == t3::IdGen(42).next());
    CHECK(t3::IdGen(42).next() != other.next());
    CHECK(t3::IdGen(0).next().size() == 16);
}

TEST_CASE("encoders emit the documented shapes")
{
    CHECK(sameJson(t3::encodeHello({40, 8, 4096, 5}, "tok", "0.1.0"),
                   R"({"type":"hello","v":1,"token":"tok","fw":"0.1.0","cols":40,"bodyRows":8,"maxFrameBytes":4096,"maxHomeRows":5})"));
    CHECK(sameJson(t3::encodeOpenThread("a1", "thr"), R"({"type":"open_thread","id":"a1","threadId":"thr"})"));
    CHECK(sameJson(t3::encodePage("a1", "thr", 3), R"({"type":"page","id":"a1","threadId":"thr","page":3})"));
    CHECK(sameJson(t3::encodeReply("a1", "thr", "hi", t3::Mode::Queue), R"({"type":"reply","id":"a1","threadId":"thr","text":"hi","mode":"queue"})"));
    CHECK(sameJson(t3::encodeReply("a1", "thr", "hi", t3::Mode::Steer), R"({"type":"reply","id":"a1","threadId":"thr","text":"hi","mode":"steer"})"));
    CHECK(sameJson(t3::encodeRespond("a1", "thr", "req", "allow_once", std::nullopt),
                   R"({"type":"respond","id":"a1","threadId":"thr","requestId":"req","value":"allow_once"})"));
    CHECK(sameJson(t3::encodeRespond("a1", "thr", "req", "deny_with_reason", std::string_view("why")),
                   R"({"type":"respond","id":"a1","threadId":"thr","requestId":"req","value":"deny_with_reason","text":"why"})"));
    CHECK(sameJson(t3::encodeLaunch("a1", "proj", "go", {}), R"({"type":"launch","id":"a1","projectId":"proj","text":"go"})"));
    CHECK(sameJson(t3::encodeLaunch("a1", "proj", "go", {std::string("m"), t3::Workspace::Worktree, t3::RuntimeMode::FullAccess}),
                   R"({"type":"launch","id":"a1","projectId":"proj","text":"go","model":"m","workspace":"worktree","runtimeMode":"full-access"})"));
    CHECK(sameJson(t3::encodeListProjects("a1"), R"({"type":"list_projects","id":"a1"})"));
    CHECK(sameJson(t3::encodeRefresh("a1"), R"({"type":"refresh","id":"a1"})"));
    CHECK(sameJson(t3::encodeAudioStart("a1"), R"({"type":"audio_start","id":"a1","sampleRate":16000})"));
    CHECK(sameJson(t3::encodeAudioEnd("a1"), R"({"type":"audio_end","id":"a1"})"));
    CHECK(sameJson(t3::encodeAudioCancel("a1"), R"({"type":"audio_cancel","id":"a1"})"));
}

TEST_CASE("encoders escape quotes, backslashes and newlines")
{
    const std::string text = "say \"hi\"\n\\path\ttab";
    const std::string encoded = t3::encodeReply("a1", "thr", text, t3::Mode::Queue).value();
    const JsonPtr json = parseJson(encoded);
    REQUIRE(json);
    CHECK(std::string(cJSON_GetObjectItemCaseSensitive(json.get(), "text")->valuestring) == text);
    CHECK(encoded.find('\n') == std::string::npos);
}

TEST_CASE("every limit constant equals the relay's messages.ts")
{
    const std::string source = readFile(std::string(T3_REPO_ROOT) + "/relay/src/protocol/messages.ts");
    CHECK(t3::ProtocolVersion == messagesConstant(source, "PROTOCOL_VERSION"));
    CHECK(t3::kRequestIdMax == messagesConstant(source, "REQUEST_ID_MAX"));
    CHECK(t3::kRefMax == messagesConstant(source, "REF_MAX"));
    CHECK(t3::kLabelMax == messagesConstant(source, "LABEL_MAX"));
    CHECK(t3::kTokenMax == messagesConstant(source, "TOKEN_MAX"));
    CHECK(t3::kFwMax == messagesConstant(source, "FW_MAX"));
    CHECK(t3::kReplyTextMax == messagesConstant(source, "REPLY_TEXT_MAX"));
    CHECK(t3::kRespondTextMax == messagesConstant(source, "RESPOND_TEXT_MAX"));
    CHECK(t3::kColsMax == messagesConstant(source, "COLS_MAX"));
    CHECK(t3::kBodyRowsMax == messagesConstant(source, "BODY_ROWS_MAX"));
    CHECK(t3::kHomeRowsMax == messagesConstant(source, "HOME_ROWS_MAX"));
    CHECK(t3::kFrameBytesMax == messagesConstant(source, "FRAME_BYTES_MAX"));
    CHECK(t3::kErrorMessageMax == messagesConstant(source, "REJECTION_TEXT_MAX"));
    CHECK(t3::kHomeAgeCols == messagesConstant(source, "HOME_AGE_COLS"));
    CHECK(t3::kDeviceFrameBytesMax == messagesConstant(source, "DEVICE_FRAME_BYTES_MAX"));
    CHECK(source.find("sampleRate: z.literal(" + std::to_string(t3::kAudioSampleRate) + ")") != std::string::npos);
}

namespace {

struct FaultHeap {
    static inline int count = 0;
    static inline int failAt = 0;
    static inline size_t live = 0;
    static inline size_t peak = 0;

    static void *allocate(size_t size)
    {
        ++count;
        if (failAt != 0 && count == failAt) {
            return nullptr;
        }
        auto *block = static_cast<size_t *>(std::malloc(size + sizeof(size_t) * 2));
        if (block == nullptr) {
            return nullptr;
        }
        block[0] = size;
        live += size;
        peak = std::max(peak, live);
        return block + 2;
    }

    static void release(void *pointer)
    {
        if (pointer == nullptr) {
            return;
        }
        auto *block = static_cast<size_t *>(pointer) - 2;
        live -= block[0];
        std::free(block);
    }

    static void reset(int failOn = 0)
    {
        count = 0;
        failAt = failOn;
        live = 0;
        peak = 0;
    }
};

struct AllocatorScope {
    AllocatorScope() { t3::setJsonAllocator({FaultHeap::allocate, FaultHeap::release}); }
    ~AllocatorScope() { t3::setJsonAllocator({std::malloc, std::free}); }
};

using Encoder = std::function<std::optional<std::string>()>;

}

TEST_CASE("an encoder that cannot allocate returns nothing, never a partial frame")
{
    const std::vector<std::pair<const char *, Encoder>> encoders = {
        {"hello", [] { return t3::encodeHello(kCaps, "tok", "0.1.0"); }},
        {"open_thread", [] { return t3::encodeOpenThread("a1", "thr"); }},
        {"page", [] { return t3::encodePage("a1", "thr", 2); }},
        {"reply", [] { return t3::encodeReply("a1", "thr", "hello there", t3::Mode::Steer); }},
        {"respond", [] { return t3::encodeRespond("a1", "thr", "req", "deny_with_reason", std::string_view("why")); }},
        {"launch", [] { return t3::encodeLaunch("a1", "proj", "go", {std::string("m"), t3::Workspace::Root, t3::RuntimeMode::Auto}); }},
        {"list_projects", [] { return t3::encodeListProjects("a1"); }},
        {"refresh", [] { return t3::encodeRefresh("a1"); }},
        {"audio_start", [] { return t3::encodeAudioStart("a1"); }},
        {"audio_end", [] { return t3::encodeAudioEnd("a1"); }},
        {"audio_cancel", [] { return t3::encodeAudioCancel("a1"); }},
    };
    for (const auto &[name, encode] : encoders) {
        INFO(name);
        const AllocatorScope scope;
        FaultHeap::reset();
        const auto complete = encode();
        REQUIRE(complete.has_value());
        const int allocations = FaultHeap::count;
        REQUIRE(allocations > 1);
        for (int failOn = 1; failOn <= allocations; ++failOn) {
            FaultHeap::reset(failOn);
            CHECK_MESSAGE(!encode().has_value(), "allocation " << failOn << " of " << allocations << " failed and a frame still came out");
        }
        FaultHeap::reset(allocations + 1);
        CHECK(encode() == complete);
    }
}

TEST_CASE("a parse that cannot allocate says heap, not invalid json")
{
    const AllocatorScope scope;
    FaultHeap::reset();
    std::string err;
    REQUIRE(t3::parseRelay(kHome, kCaps, err).has_value());
    const int allocations = FaultHeap::count;
    REQUIRE(allocations > 10);
    for (int failOn = 1; failOn <= allocations; ++failOn) {
        FaultHeap::reset(failOn);
        err.clear();
        CHECK_FALSE(t3::parseRelay(kHome, kCaps, err).has_value());
        CHECK_MESSAGE(err == "heap: parse needed more than available, frame was " + std::to_string(std::strlen(kHome)) + " bytes", "allocation " << failOn << ": " << err);
    }

    FaultHeap::reset();
    err.clear();
    CHECK_FALSE(t3::parseRelay("{not json", kCaps, err).has_value());
    CHECK(err.rfind("frame: not valid json", 0) == 0);
}

TEST_CASE("a frame over the declared cap is rejected before anything is allocated")
{
    const AllocatorScope scope;
    FaultHeap::reset();
    std::string err;
    const std::string oversize = R"({"type":"transcript_final","text":")" + std::string(5000, 'a') + R"("})";
    CHECK_FALSE(t3::parseRelay(oversize, kCaps, err).has_value());
    CHECK(FaultHeap::count == 0);
}

namespace {

std::string repeated(const std::string &item, int times)
{
    std::string out;
    for (int i = 0; i < times; ++i) {
        out += (i == 0 ? "" : ",") + item;
    }
    return out;
}

void reportPeak(const char *name, const std::string &frame, const t3::HelloCaps &caps)
{
    const AllocatorScope scope;
    FaultHeap::reset();
    const size_t before = mallinfo2().uordblks;
    std::string err;
    const auto parsed = t3::parseRelay(frame, caps, err);
    const size_t after = mallinfo2().uordblks;
    REQUIRE_MESSAGE(parsed.has_value(), name << ": " << err);
    const size_t typed = after > before ? after - before : 0;
    const size_t total = FaultHeap::peak + typed;
    std::printf("PEAK %-28s frame=%6zu tree=%7zu typed=%7zu total=%7zu ratio=%.1fx\n", name, frame.size(), FaultHeap::peak, typed, total,
                static_cast<double>(total) / static_cast<double>(frame.size()));
}

}

TEST_CASE("parse peak table for docs/receipts (host 64-bit upper bound)")
{
    const t3::HelloCaps wide{40, 11, 65536, 255};
    const std::string row = R"({"threadId":"thr_0123456789","kind":"running","project":"api-gateway","title":"fix flaky test sweep","age":"5m"})";
    const std::string homeTail = R"(],"counts":{"needs":0,"running":255,"done":0},"approvals":{"available":true},"warnings":[],"t3":"ok"})";
    reportPeak("home 255 rows", R"({"type":"home","rows":[)" + repeated(row, 255) + homeTail, wide);
    reportPeak("home 8 rows", R"({"type":"home","rows":[)" + repeated(row, 8) + homeTail, wide);

    const std::string warning = "\"" + std::string(120, 'w') + "\"";
    reportPeak("home 16 warnings x 120", R"({"type":"home","rows":[],"counts":{"needs":0,"running":0,"done":0},"approvals":{"available":true},"warnings":[)" + repeated(warning, 16) + R"(],"t3":"ok"})", wide);
    reportPeak("home 1000 empty warnings", R"({"type":"home","rows":[],"counts":{"needs":0,"running":0,"done":0},"approvals":{"available":true},"warnings":[)" + repeated("\"\"", 1000) + R"(],"t3":"ok"})", wide);

    const std::string line = "\"" + std::string(40, 'l') + "\"";
    reportPeak("thread_page 11 lines x 40", R"({"type":"thread_page","threadId":"thr_01","header":{"project":"api","title":"run migration","model":"claude-opus-5","status":"running"},"page":1,"pages":3,"lines":[)" + repeated(line, 11) + "]}", wide);
    reportPeak("request 7 lines + 4 options", R"({"type":"request","threadId":"t","requestId":"r","kind":"approval","lines":[)" + repeated(line, 7) +
                                                  R"(],"options":[{"key":"Y","label":"Allow once","value":"allow_once"},{"key":"A","label":"Always allow","value":"allow_always"},{"key":"N","label":"Deny","value":"deny"},{"key":"T","label":"Deny, say why","value":"deny_with_reason"}]})", wide);
    reportPeak("projects 255 items", R"({"type":"projects","items":[)" + repeated(R"({"projectId":"proj_0123456789","name":"api-gateway","defaults":{"model":"claude-opus-5","workspace":"worktree","runtimeMode":"approval-required"}})", 255) + "]}", wide);
}
