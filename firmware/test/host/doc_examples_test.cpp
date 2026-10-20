#include "doctest.h"

#include <algorithm>
#include <fstream>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "cJSON.h"
#include "t3/protocol.h"

namespace {

struct JsonDeleter {
    void operator()(cJSON *json) const { cJSON_Delete(json); }
};
using JsonPtr = std::unique_ptr<cJSON, JsonDeleter>;

struct Example {
    std::string side;
    std::string json;
    int line;
};

std::vector<Example> docExamples()
{
    std::ifstream in(std::string(T3_REPO_ROOT) + "/docs/protocol.md");
    REQUIRE(in.good());
    std::vector<Example> examples;
    std::string line;
    std::string side;
    std::string body;
    int number = 0;
    int start = 0;
    bool inside = false;
    while (std::getline(in, line)) {
        ++number;
        if (!inside && line.rfind("```json ", 0) == 0) {
            side = line.substr(8);
            inside = true;
            body.clear();
            start = number;
        } else if (!inside && line.rfind("```json", 0) == 0) {
            inside = true;
            side.clear();
            body.clear();
            start = number;
        } else if (inside && line == "```") {
            inside = false;
            if (!side.empty()) {
                examples.push_back({side, body, start});
            }
        } else if (inside) {
            body += line;
        }
    }
    return examples;
}

t3::HelloCaps docHelloCaps()
{
    for (const Example &example : docExamples()) {
        if (example.side == "device" && example.json.find("\"type\":\"hello\"") != std::string::npos) {
            const JsonPtr json(cJSON_Parse(example.json.c_str()));
            REQUIRE(json);
            const auto number = [&](const char *key) { return static_cast<int>(cJSON_GetObjectItemCaseSensitive(json.get(), key)->valuedouble); };
            return {number("cols"), number("bodyRows"), number("maxFrameBytes"), number("maxHomeRows")};
        }
    }
    FAIL("docs/protocol.md has no hello example");
    return {};
}

std::string typeOf(const std::string &json)
{
    const JsonPtr parsed(cJSON_Parse(json.c_str()));
    REQUIRE(parsed);
    return cJSON_GetObjectItemCaseSensitive(parsed.get(), "type")->valuestring;
}

std::string str(const cJSON *obj, const char *key)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return item != nullptr && cJSON_IsString(item) ? item->valuestring : "";
}

std::optional<std::string> optStr(const cJSON *obj, const char *key)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (item == nullptr) {
        return std::nullopt;
    }
    return std::string(item->valuestring);
}

int num(const cJSON *obj, const char *key)
{
    return static_cast<int>(cJSON_GetObjectItemCaseSensitive(obj, key)->valuedouble);
}

t3::Workspace workspaceOf(const std::string &text)
{
    return text == "root" ? t3::Workspace::Root : t3::Workspace::Worktree;
}

t3::RuntimeMode runtimeModeOf(const std::string &text)
{
    for (t3::RuntimeMode mode : {t3::RuntimeMode::ApprovalRequired, t3::RuntimeMode::AutoAcceptEdits, t3::RuntimeMode::Auto, t3::RuntimeMode::FullAccess}) {
        if (t3::runtimeModeName(mode) == text) {
            return mode;
        }
    }
    FAIL("unknown runtime mode " << text);
    return t3::RuntimeMode::Auto;
}

std::optional<std::string> encodeFromExample(const std::string &type, const cJSON *json)
{
    if (type == "hello") {
        return t3::encodeHello({num(json, "cols"), num(json, "bodyRows"), num(json, "maxFrameBytes"), num(json, "maxHomeRows")}, str(json, "token"), str(json, "fw"));
    }
    if (type == "open_thread") {
        return t3::encodeOpenThread(str(json, "id"), str(json, "threadId"));
    }
    if (type == "page") {
        return t3::encodePage(str(json, "id"), str(json, "threadId"), num(json, "page"));
    }
    if (type == "reply") {
        return t3::encodeReply(str(json, "id"), str(json, "threadId"), str(json, "text"), str(json, "mode") == "steer" ? t3::Mode::Steer : t3::Mode::Queue);
    }
    if (type == "respond") {
        const auto text = optStr(json, "text");
        return t3::encodeRespond(str(json, "id"), str(json, "threadId"), str(json, "requestId"), str(json, "value"),
                                 text ? std::optional<std::string_view>(*text) : std::nullopt);
    }
    if (type == "launch") {
        t3::LaunchOptions options;
        options.model = optStr(json, "model");
        if (const auto workspace = optStr(json, "workspace")) {
            options.workspace = workspaceOf(*workspace);
        }
        if (const auto mode = optStr(json, "runtimeMode")) {
            options.runtimeMode = runtimeModeOf(*mode);
        }
        return t3::encodeLaunch(str(json, "id"), str(json, "projectId"), str(json, "text"), options);
    }
    if (type == "list_projects") {
        return t3::encodeListProjects(str(json, "id"));
    }
    if (type == "refresh") {
        return t3::encodeRefresh(str(json, "id"));
    }
    if (type == "audio_start") {
        return t3::encodeAudioStart(str(json, "id"));
    }
    if (type == "audio_end") {
        return t3::encodeAudioEnd(str(json, "id"));
    }
    if (type == "audio_cancel") {
        return t3::encodeAudioCancel(str(json, "id"));
    }
    FAIL("no encoder for device message type " << type);
    return std::nullopt;
}

size_t variantIndexFor(const std::string &type)
{
    static const std::map<std::string, size_t> indexes = {
        {"welcome", 0}, {"ack", 1},      {"home", 2},          {"thread_page", 3},       {"request", 4},
        {"projects", 5}, {"transcript_partial", 6}, {"transcript_final", 7}, {"error", 8},
    };
    const auto found = indexes.find(type);
    REQUIRE_MESSAGE(found != indexes.end(), "doc has a relay message type the firmware does not know: " << type);
    return found->second;
}

}

TEST_CASE("every relay example in protocol.md parses")
{
    const t3::HelloCaps caps = docHelloCaps();
    std::set<std::string> seen;
    int count = 0;
    for (const Example &example : docExamples()) {
        if (example.side != "relay") {
            continue;
        }
        ++count;
        std::string err;
        const auto msg = t3::parseRelay(example.json, caps, err);
        INFO("docs/protocol.md:" << example.line << " " << example.json);
        REQUIRE_MESSAGE(msg.has_value(), err);
        const std::string type = typeOf(example.json);
        CHECK(msg->index() == variantIndexFor(type));
        seen.insert(type);
    }
    CHECK(count >= 9);
    for (const char *type : {"welcome", "ack", "home", "thread_page", "request", "projects", "transcript_partial", "transcript_final", "error"}) {
        CHECK_MESSAGE(seen.count(type) == 1, "protocol.md has no relay example for " << type);
    }
}

TEST_CASE("the projects example with models keeps every model")
{
    const t3::HelloCaps caps = docHelloCaps();
    int withModels = 0;
    for (const Example &example : docExamples()) {
        if (example.side != "relay" || typeOf(example.json) != "projects") {
            continue;
        }
        const JsonPtr json(cJSON_Parse(example.json.c_str()));
        const cJSON *models = cJSON_GetObjectItemCaseSensitive(json.get(), "models");
        if (models == nullptr) {
            continue;
        }
        ++withModels;
        std::string err;
        const auto msg = t3::parseRelay(example.json, caps, err);
        REQUIRE_MESSAGE(msg.has_value(), err);
        const auto &projects = std::get<t3::Projects>(*msg);
        REQUIRE(projects.models.size() == static_cast<size_t>(cJSON_GetArraySize(models)));
        const cJSON *first = cJSON_GetArrayItem(models, 0);
        CHECK(projects.models[0].id == str(first, "id"));
        CHECK(projects.models[0].label == str(first, "label"));
    }
    CHECK(withModels >= 1);
}

TEST_CASE("every device message we encode parses back to the doc's shape")
{
    std::set<std::string> seen;
    for (const Example &example : docExamples()) {
        if (example.side != "device") {
            continue;
        }
        INFO("docs/protocol.md:" << example.line << " " << example.json);
        const JsonPtr expected(cJSON_Parse(example.json.c_str()));
        REQUIRE(expected);
        const std::string type = typeOf(example.json);
        const auto produced = encodeFromExample(type, expected.get());
        REQUIRE(produced.has_value());
        const std::string &encoded = *produced;
        const JsonPtr actual(cJSON_Parse(encoded.c_str()));
        REQUIRE_MESSAGE(actual, encoded);
        CHECK_MESSAGE(cJSON_Compare(actual.get(), expected.get(), true), encoded << " != " << example.json);
        seen.insert(type);
    }
    for (const char *type : {"hello", "open_thread", "page", "reply", "respond", "launch", "list_projects", "refresh", "audio_start", "audio_end", "audio_cancel"}) {
        CHECK_MESSAGE(seen.count(type) == 1, "protocol.md has no device example for " << type);
    }
}

TEST_CASE("every doc example fits the limits the parser enforces")
{
    for (const Example &example : docExamples()) {
        if (example.side == "relay") {
            CHECK(example.json.size() < static_cast<size_t>(t3::kFrameBytesMax));
        }
    }
}
