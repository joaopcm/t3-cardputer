#include "t3/protocol.h"

#include <cmath>
#include <cstring>
#include <limits>
#include <memory>

#include "cJSON.h"

namespace t3 {

namespace {

struct JsonDeleter {
    void operator()(cJSON *json) const { cJSON_Delete(json); }
};
using JsonPtr = std::unique_ptr<cJSON, JsonDeleter>;

struct TextRule {
    size_t min;
    size_t max;
    const char *budget;
};

constexpr size_t kUnbounded = std::numeric_limits<size_t>::max();
constexpr TextRule kRequestId{1, kRequestIdMax, "request_id_max"};
constexpr TextRule kRef{1, kRefMax, "ref_max"};
constexpr TextRule kLabel{1, kLabelMax, "label_max"};
constexpr TextRule kOptionKey{1, 1, "key_chars"};
constexpr TextRule kAge{1, kHomeAgeCols, "home_age_cols"};
constexpr TextRule kCol{0, kColsMax, "cols_max"};
constexpr TextRule kErrorMessage{0, kErrorMessageMax, "error_message_max"};
constexpr TextRule kFrameBound{0, kUnbounded, ""};
// receipt: longest relay message type is transcript_partial (18 chars), a clipped echo of an unknown type only has to be readable on a 40 column screen
constexpr size_t kTypeEchoMax = 32;

template <typename E>
struct Name {
    std::string_view text;
    E value;
};

constexpr Name<HomeKind> kHomeKinds[] = {
    {"approval", HomeKind::Approval}, {"question", HomeKind::Question}, {"failed", HomeKind::Failed},
    {"running", HomeKind::Running},   {"done", HomeKind::Done},
};
constexpr Name<RequestKind> kRequestKinds[] = {{"approval", RequestKind::Approval}, {"question", RequestKind::Question}};
constexpr Name<T3Status> kT3Statuses[] = {{"ok", T3Status::Ok}, {"unreachable", T3Status::Unreachable}};
constexpr Name<Workspace> kWorkspaces[] = {{"root", Workspace::Root}, {"worktree", Workspace::Worktree}};
constexpr Name<RuntimeMode> kRuntimeModes[] = {
    {"approval-required", RuntimeMode::ApprovalRequired},
    {"auto-accept-edits", RuntimeMode::AutoAcceptEdits},
    {"auto", RuntimeMode::Auto},
    {"full-access", RuntimeMode::FullAccess},
};
constexpr Name<ErrorCode> kErrorCodes[] = {
    {"protocol_version", ErrorCode::ProtocolVersion}, {"auth", ErrorCode::Auth},
    {"hello_timeout", ErrorCode::HelloTimeout},       {"bad_message", ErrorCode::BadMessage},
    {"bad_audio", ErrorCode::BadAudio},               {"audio_not_started", ErrorCode::AudioNotStarted},
    {"internal", ErrorCode::Internal},
};

std::string join(const std::string &base, const char *key)
{
    return base.empty() ? std::string(key) : base + "." + key;
}

std::string element(const std::string &path, int index)
{
    return path + "[" + std::to_string(index) + "]";
}

class Parser {
public:
    explicit Parser(std::string &err) : err_(err) {}

    bool fail(const std::string &text)
    {
        err_ = text;
        return false;
    }

    const cJSON *required(const cJSON *obj, const char *key, const std::string &base)
    {
        const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
        if (item == nullptr || cJSON_IsNull(item)) {
            fail(join(base, key));
            return nullptr;
        }
        return item;
    }

    static const cJSON *optional(const cJSON *obj, const char *key)
    {
        const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
        return item == nullptr || cJSON_IsNull(item) ? nullptr : item;
    }

    bool textValue(const cJSON *item, const std::string &path, const TextRule &rule, std::string &out)
    {
        if (!cJSON_IsString(item) || item->valuestring == nullptr) {
            return fail(path + ": expected string");
        }
        const size_t length = std::strlen(item->valuestring);
        if (length < rule.min) {
            return fail(path + ": min_chars=" + std::to_string(rule.min) + ", got " + std::to_string(length));
        }
        if (length > rule.max) {
            return fail(path + ": " + rule.budget + "=" + std::to_string(rule.max) + ", got " + std::to_string(length));
        }
        out = item->valuestring;
        return true;
    }

    bool text(const cJSON *obj, const char *key, const std::string &base, const TextRule &rule, std::string &out)
    {
        const cJSON *item = required(obj, key, base);
        return item != nullptr && textValue(item, join(base, key), rule, out);
    }

    bool optionalText(const cJSON *obj, const char *key, const std::string &base, const TextRule &rule, std::optional<std::string> &out)
    {
        const cJSON *item = optional(obj, key);
        if (item == nullptr) {
            out.reset();
            return true;
        }
        std::string value;
        if (!textValue(item, join(base, key), rule, value)) {
            return false;
        }
        out = std::move(value);
        return true;
    }

    bool integerValue(const cJSON *item, const std::string &path, long long min, int &out)
    {
        if (!cJSON_IsNumber(item) || std::floor(item->valuedouble) != item->valuedouble ||
            item->valuedouble > std::numeric_limits<int>::max() || item->valuedouble < std::numeric_limits<int>::min()) {
            return fail(path + ": expected integer");
        }
        if (item->valuedouble < static_cast<double>(min)) {
            return fail(path + ": min=" + std::to_string(min) + ", got " + std::to_string(static_cast<long long>(item->valuedouble)));
        }
        out = static_cast<int>(item->valuedouble);
        return true;
    }

    bool integer(const cJSON *obj, const char *key, const std::string &base, long long min, int &out)
    {
        const cJSON *item = required(obj, key, base);
        return item != nullptr && integerValue(item, join(base, key), min, out);
    }

    bool boolean(const cJSON *obj, const char *key, const std::string &base, bool &out)
    {
        const cJSON *item = required(obj, key, base);
        if (item == nullptr) {
            return false;
        }
        if (!cJSON_IsBool(item)) {
            return fail(join(base, key) + ": expected boolean");
        }
        out = cJSON_IsTrue(item);
        return true;
    }

    const cJSON *object(const cJSON *obj, const char *key, const std::string &base)
    {
        const cJSON *item = required(obj, key, base);
        if (item != nullptr && !cJSON_IsObject(item)) {
            fail(join(base, key) + ": expected object");
            return nullptr;
        }
        return item;
    }

    const cJSON *array(const cJSON *obj, const char *key, const std::string &base, int maxItems, const char *budget)
    {
        const cJSON *item = required(obj, key, base);
        if (item == nullptr) {
            return nullptr;
        }
        if (!cJSON_IsArray(item)) {
            fail(join(base, key) + ": expected array");
            return nullptr;
        }
        const int size = cJSON_GetArraySize(item);
        if (size > maxItems) {
            fail(join(base, key) + ": " + budget + "=" + std::to_string(maxItems) + ", got " + std::to_string(size));
            return nullptr;
        }
        return item;
    }

    bool elementObject(const cJSON *item, const std::string &path)
    {
        return cJSON_IsObject(item) || fail(path + ": expected object");
    }

    template <typename E, size_t N>
    bool enumeration(const cJSON *obj, const char *key, const std::string &base, const Name<E> (&names)[N], E &out)
    {
        std::string word;
        if (!text(obj, key, base, kFrameBound, word)) {
            return false;
        }
        for (const Name<E> &name : names) {
            if (name.text == word) {
                out = name.value;
                return true;
            }
        }
        return fail(join(base, key) + ": unknown '" + word.substr(0, kTypeEchoMax) + "'");
    }

    bool stringList(const cJSON *obj, const char *key, const std::string &base, int maxItems, const char *budget, const TextRule &rule,
                    std::vector<std::string> &out)
    {
        const cJSON *list = array(obj, key, base, maxItems, budget);
        if (list == nullptr) {
            return false;
        }
        const std::string path = join(base, key);
        out.clear();
        int index = 0;
        for (const cJSON *item = list->child; item != nullptr; item = item->next, ++index) {
            std::string value;
            if (!textValue(item, element(path, index), rule, value)) {
                return false;
            }
            out.push_back(std::move(value));
        }
        return true;
    }

private:
    std::string &err_;
};

bool parseWelcome(Parser &p, const cJSON *json, Welcome &out)
{
    return p.integer(json, "v", "", std::numeric_limits<int>::min(), out.v) && p.text(json, "relay", "", kFrameBound, out.relay);
}

bool parseAck(Parser &p, const cJSON *json, Ack &out)
{
    return p.text(json, "id", "", kRequestId, out.id) && p.boolean(json, "ok", "", out.ok) &&
           p.optionalText(json, "error", "", kFrameBound, out.error);
}

bool parseHomeRow(Parser &p, const cJSON *json, const std::string &path, HomeRow &out)
{
    return p.elementObject(json, path) && p.text(json, "threadId", path, kRef, out.threadId) &&
           p.enumeration(json, "kind", path, kHomeKinds, out.kind) && p.text(json, "project", path, kCol, out.project) &&
           p.text(json, "title", path, kCol, out.title) && p.text(json, "age", path, kAge, out.age);
}

bool parseHome(Parser &p, const cJSON *json, Home &out)
{
    const cJSON *rows = p.array(json, "rows", "", kHomeRowsMax, "home_rows_max");
    if (rows == nullptr) {
        return false;
    }
    int index = 0;
    for (const cJSON *item = rows->child; item != nullptr; item = item->next, ++index) {
        HomeRow row;
        if (!parseHomeRow(p, item, element("rows", index), row)) {
            return false;
        }
        out.rows.push_back(std::move(row));
    }

    const cJSON *counts = p.object(json, "counts", "");
    if (counts == nullptr || !p.integer(counts, "needs", "counts", 0, out.counts.needs) ||
        !p.integer(counts, "running", "counts", 0, out.counts.running) || !p.integer(counts, "done", "counts", 0, out.counts.done)) {
        return false;
    }

    const cJSON *approvals = p.object(json, "approvals", "");
    if (approvals == nullptr || !p.boolean(approvals, "available", "approvals", out.approvals.available) ||
        !p.optionalText(approvals, "reason", "approvals", kFrameBound, out.approvals.reason)) {
        return false;
    }

    return p.stringList(json, "warnings", "", std::numeric_limits<int>::max(), "warnings", kFrameBound, out.warnings) &&
           p.enumeration(json, "t3", "", kT3Statuses, out.t3);
}

bool parseThreadPage(Parser &p, const cJSON *json, ThreadPage &out)
{
    if (!p.text(json, "threadId", "", kRef, out.threadId)) {
        return false;
    }
    const cJSON *header = p.object(json, "header", "");
    if (header == nullptr || !p.text(header, "project", "header", kFrameBound, out.header.project) ||
        !p.text(header, "title", "header", kFrameBound, out.header.title) || !p.text(header, "model", "header", kFrameBound, out.header.model) ||
        !p.text(header, "status", "header", kFrameBound, out.header.status)) {
        return false;
    }
    if (!p.integer(json, "page", "", 1, out.page) || !p.integer(json, "pages", "", 1, out.pages) ||
        !p.stringList(json, "lines", "", kBodyRowsMax, "body_rows_max", kCol, out.lines)) {
        return false;
    }
    if (const cJSON *truncated = Parser::optional(json, "truncated")) {
        if (!cJSON_IsObject(truncated)) {
            return p.fail("truncated: expected object");
        }
        PageTruncated value;
        if (!p.text(truncated, "budget", "truncated", kFrameBound, value.budget) || !p.integer(truncated, "limit", "truncated", 0, value.limit) ||
            !p.integer(truncated, "actual", "truncated", 0, value.actual)) {
            return false;
        }
        out.truncated = std::move(value);
    }
    return true;
}

bool parseOption(Parser &p, const cJSON *json, const std::string &path, Option &out)
{
    std::string key;
    if (!p.elementObject(json, path) || !p.text(json, "key", path, kOptionKey, key) || !p.text(json, "label", path, kLabel, out.label) ||
        !p.text(json, "value", path, kRef, out.value)) {
        return false;
    }
    out.key = key[0];
    return true;
}

bool parseRequest(Parser &p, const cJSON *json, Request &out)
{
    if (!p.text(json, "threadId", "", kRef, out.threadId) || !p.text(json, "requestId", "", kRef, out.requestId) ||
        !p.enumeration(json, "kind", "", kRequestKinds, out.kind) ||
        !p.stringList(json, "lines", "", kBodyRowsMax, "body_rows_max", kCol, out.lines)) {
        return false;
    }
    const cJSON *options = p.array(json, "options", "", kBodyRowsMax, "body_rows_max");
    if (options == nullptr) {
        return false;
    }
    int index = 0;
    for (const cJSON *item = options->child; item != nullptr; item = item->next, ++index) {
        Option option;
        if (!parseOption(p, item, element("options", index), option)) {
            return false;
        }
        out.options.push_back(std::move(option));
    }
    return true;
}

bool parseProjectItem(Parser &p, const cJSON *json, const std::string &path, ProjectItem &out)
{
    if (!p.elementObject(json, path) || !p.text(json, "projectId", path, kRef, out.projectId) || !p.text(json, "name", path, kCol, out.name)) {
        return false;
    }
    const cJSON *defaults = p.object(json, "defaults", path);
    const std::string defaultsPath = join(path, "defaults");
    return defaults != nullptr && p.text(defaults, "model", defaultsPath, kFrameBound, out.defaults.model) &&
           p.enumeration(defaults, "workspace", defaultsPath, kWorkspaces, out.defaults.workspace) &&
           p.enumeration(defaults, "runtimeMode", defaultsPath, kRuntimeModes, out.defaults.runtimeMode);
}

bool parseProjects(Parser &p, const cJSON *json, Projects &out)
{
    const cJSON *items = p.array(json, "items", "", kHomeRowsMax, "home_rows_max");
    if (items == nullptr) {
        return false;
    }
    int index = 0;
    for (const cJSON *item = items->child; item != nullptr; item = item->next, ++index) {
        ProjectItem project;
        if (!parseProjectItem(p, item, element("items", index), project)) {
            return false;
        }
        out.items.push_back(std::move(project));
    }
    if (const cJSON *truncated = Parser::optional(json, "truncated")) {
        if (!cJSON_IsObject(truncated)) {
            return p.fail("truncated: expected object");
        }
        ProjectsTruncated value;
        if (!p.text(truncated, "budget", "truncated", kFrameBound, value.budget) || !p.integer(truncated, "limit", "truncated", 0, value.limit) ||
            !p.integer(truncated, "actual", "truncated", 0, value.actual) || !p.integer(truncated, "hidden", "truncated", 0, value.hidden)) {
            return false;
        }
        out.truncated = std::move(value);
    }
    return true;
}

bool parseErrorMessage(Parser &p, const cJSON *json, Error &out)
{
    return p.enumeration(json, "code", "", kErrorCodes, out.code) && p.text(json, "message", "", kErrorMessage, out.message);
}

template <typename T, typename Fn>
std::optional<RelayMsg> build(Parser &p, const cJSON *json, Fn parse)
{
    T value;
    if (!parse(p, json, value)) {
        return std::nullopt;
    }
    return RelayMsg(std::move(value));
}

class Builder {
public:
    explicit Builder(const char *type) : root_(cJSON_CreateObject())
    {
        str("type", type);
    }

    Builder &str(const char *key, std::string_view value)
    {
        cJSON_AddStringToObject(root_.get(), key, std::string(value).c_str());
        return *this;
    }

    Builder &num(const char *key, int value)
    {
        cJSON_AddNumberToObject(root_.get(), key, value);
        return *this;
    }

    std::string print()
    {
        char *raw = cJSON_PrintUnformatted(root_.get());
        if (raw == nullptr) {
            return {};
        }
        std::string out(raw);
        cJSON_free(raw);
        return out;
    }

private:
    JsonPtr root_;
};

bool startsWith(std::string_view text, std::string_view prefix)
{
    return text.substr(0, prefix.size()) == prefix;
}

}

std::string_view workspaceName(Workspace value)
{
    for (const Name<Workspace> &name : kWorkspaces) {
        if (name.value == value) {
            return name.text;
        }
    }
    return {};
}

std::string_view runtimeModeName(RuntimeMode value)
{
    for (const Name<RuntimeMode> &name : kRuntimeModes) {
        if (name.value == value) {
            return name.text;
        }
    }
    return {};
}

std::string_view modeName(Mode value)
{
    return value == Mode::Steer ? "steer" : "queue";
}

std::optional<RelayMsg> parseRelay(std::string_view json, std::string &err)
{
    Parser p(err);
    if (json.size() > static_cast<size_t>(kFrameBytesMax)) {
        p.fail("frame: frame_bytes_max=" + std::to_string(kFrameBytesMax) + ", got " + std::to_string(json.size()));
        return std::nullopt;
    }
    const char *parseEnd = nullptr;
    const JsonPtr root(cJSON_ParseWithLengthOpts(json.data(), json.size(), &parseEnd, false));
    if (!root) {
        p.fail("frame: not valid json at byte " + std::to_string(parseEnd == nullptr ? 0 : parseEnd - json.data()));
        return std::nullopt;
    }
    if (!cJSON_IsObject(root.get())) {
        p.fail("message: expected object");
        return std::nullopt;
    }

    const cJSON *typeItem = p.required(root.get(), "type", "");
    std::string type;
    if (typeItem == nullptr || !p.textValue(typeItem, "type", kFrameBound, type)) {
        return std::nullopt;
    }

    if (type == "welcome") return build<Welcome>(p, root.get(), parseWelcome);
    if (type == "ack") return build<Ack>(p, root.get(), parseAck);
    if (type == "home") return build<Home>(p, root.get(), parseHome);
    if (type == "thread_page") return build<ThreadPage>(p, root.get(), parseThreadPage);
    if (type == "request") return build<Request>(p, root.get(), parseRequest);
    if (type == "projects") return build<Projects>(p, root.get(), parseProjects);
    if (type == "transcript_partial") {
        return build<TranscriptPartial>(p, root.get(), [](Parser &q, const cJSON *j, TranscriptPartial &v) { return q.text(j, "text", "", kFrameBound, v.text); });
    }
    if (type == "transcript_final") {
        return build<TranscriptFinal>(p, root.get(), [](Parser &q, const cJSON *j, TranscriptFinal &v) { return q.text(j, "text", "", kFrameBound, v.text); });
    }
    if (type == "error") return build<Error>(p, root.get(), parseErrorMessage);

    p.fail("type: unknown '" + type.substr(0, kTypeEchoMax) + "'");
    return std::nullopt;
}

std::string encodeHello(const HelloCaps &caps, std::string_view token, std::string_view fw)
{
    return Builder("hello")
        .num("v", ProtocolVersion)
        .str("token", token)
        .str("fw", fw)
        .num("cols", caps.cols)
        .num("bodyRows", caps.bodyRows)
        .num("maxFrameBytes", caps.maxFrameBytes)
        .num("maxHomeRows", caps.maxHomeRows)
        .print();
}

std::string encodeOpenThread(std::string_view id, std::string_view threadId)
{
    return Builder("open_thread").str("id", id).str("threadId", threadId).print();
}

std::string encodePage(std::string_view id, std::string_view threadId, int page)
{
    return Builder("page").str("id", id).str("threadId", threadId).num("page", page).print();
}

std::string encodeReply(std::string_view id, std::string_view threadId, std::string_view text, Mode mode)
{
    return Builder("reply").str("id", id).str("threadId", threadId).str("text", text).str("mode", modeName(mode)).print();
}

std::string encodeRespond(std::string_view id, std::string_view threadId, std::string_view requestId, std::string_view value,
                          std::optional<std::string_view> text)
{
    Builder builder("respond");
    builder.str("id", id).str("threadId", threadId).str("requestId", requestId).str("value", value);
    if (text) {
        builder.str("text", *text);
    }
    return builder.print();
}

std::string encodeLaunch(std::string_view id, std::string_view projectId, std::string_view text, const LaunchOptions &options)
{
    Builder builder("launch");
    builder.str("id", id).str("projectId", projectId).str("text", text);
    if (options.model) {
        builder.str("model", *options.model);
    }
    if (options.workspace) {
        builder.str("workspace", workspaceName(*options.workspace));
    }
    if (options.runtimeMode) {
        builder.str("runtimeMode", runtimeModeName(*options.runtimeMode));
    }
    return builder.print();
}

std::string encodeListProjects(std::string_view id)
{
    return Builder("list_projects").str("id", id).print();
}

std::string encodeRefresh(std::string_view id)
{
    return Builder("refresh").str("id", id).print();
}

std::string encodeAudioStart(std::string_view id)
{
    return Builder("audio_start").str("id", id).num("sampleRate", kAudioSampleRate).print();
}

std::string encodeAudioEnd(std::string_view id)
{
    return Builder("audio_end").str("id", id).print();
}

std::string encodeAudioCancel(std::string_view id)
{
    return Builder("audio_cancel").str("id", id).print();
}

std::string IdGen::next()
{
    state_ += 0x9e3779b97f4a7c15ULL;
    uint64_t z = state_;
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    z ^= z >> 31;
    constexpr char kHex[] = "0123456789abcdef";
    std::string id(16, '0');
    for (int i = 15; i >= 0; --i) {
        id[i] = kHex[z & 0xf];
        z >>= 4;
    }
    return id;
}

CloseAction closeAction(int code, std::string_view errorMessage)
{
    switch (code) {
    case 4401:
        return CloseAction::RePair;
    case 4400:
        if (startsWith(errorMessage, "update relay")) {
            return CloseAction::UpdateRelay;
        }
        if (startsWith(errorMessage, "update firmware")) {
            return CloseAction::UpdateFirmware;
        }
        return CloseAction::ShowAndStop;
    case 4402:
    case 4000:
        return CloseAction::ShowAndStop;
    default:
        return CloseAction::Reconnect;
    }
}

}
