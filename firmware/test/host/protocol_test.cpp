#include "doctest.h"

#include <fstream>
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

bool sameJson(const std::string &actual, const std::string &expected)
{
    const JsonPtr a = parseJson(actual);
    const JsonPtr b = parseJson(expected);
    return a && b && cJSON_Compare(a.get(), b.get(), true);
}

template <typename T>
T parseAs(const std::string &json)
{
    static std::optional<t3::RelayMsg> keep;
    std::string err;
    keep = t3::parseRelay(json, err);
    REQUIRE_MESSAGE(keep.has_value(), err);
    const T *msg = std::get_if<T>(&*keep);
    REQUIRE(msg != nullptr);
    return *msg;
}

std::string parseError(const std::string &json)
{
    std::string err;
    const auto msg = t3::parseRelay(json, err);
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
    CHECK(parseError(R"({"type":"home","rows":[{"threadId":"t","kind":"sleeping","project":"p","title":"t","age":"1m"}],"counts":{"needs":0,"running":0,"done":0},"approvals":{"available":true},"warnings":[],"t3":"ok"})") == "rows[0].kind: unknown 'sleeping'");
    CHECK(parseError(R"({"type":"nope"})") == "type: unknown 'nope'");
    CHECK(parseError("[1,2]") == "message: expected object");
    CHECK_FALSE(parseError("{not json").empty());
    CHECK_FALSE(parseError("").empty());
}

TEST_CASE("parser limits name the budget, the limit and the ask")
{
    CHECK(parseError(R"({"type":"ack","id":"12345678901234567","ok":true})") == "id: request_id_max=16, got 17");
    CHECK(parseError(R"({"type":"ack","id":"","ok":true})") == "id: min_chars=1, got 0");

    std::string tooManyLines = R"({"type":"thread_page","threadId":"t","header":{"project":"p","title":"t","model":"m","status":"s"},"page":1,"pages":1,"lines":[)";
    for (int i = 0; i < 65; ++i) {
        tooManyLines += i == 0 ? "\"x\"" : ",\"x\"";
    }
    tooManyLines += "]}";
    CHECK(parseError(tooManyLines) == "lines: body_rows_max=64, got 65");

    const std::string wide(256, 'x');
    CHECK(parseError(R"({"type":"request","threadId":"t","requestId":"r","kind":"approval","lines":[")" + wide + R"("],"options":[]})") ==
          "lines[0]: cols_max=255, got 256");
    CHECK(parseError(R"({"type":"request","threadId":"t","requestId":"r","kind":"approval","lines":[],"options":[{"key":"YN","label":"a","value":"v"}]})") ==
          "options[0].key: key_chars=1, got 2");
    CHECK(parseError(R"({"type":"request","threadId":"t","requestId":"r","kind":"approval","lines":[],"options":[{"key":"Y","label":")" + std::string(65, 'l') + R"(","value":"v"}]})") ==
          "options[0].label: label_max=64, got 65");
    CHECK(parseError(R"({"type":"error","code":"internal","message":")" + std::string(121, 'm') + R"("})") == "message: error_message_max=120, got 121");

    const std::string oversize = R"({"type":"transcript_final","text":")" + std::string(t3::kFrameBytesMax, 'a') + R"("})";
    CHECK(parseError(oversize) == "frame: frame_bytes_max=1048576, got " + std::to_string(oversize.size()));
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
    const std::string encoded = t3::encodeReply("a1", "thr", text, t3::Mode::Queue);
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
