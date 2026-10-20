#include "demo_relay.h"

#include "cJSON.h"

const char kDemoHome[] = R"({"type":"home","rows":[
{"threadId":"thr_bounce","kind":"approval","project":"resend-api","title":"fix bounce webhook","age":"3m"},
{"threadId":"thr_layout","kind":"question","project":"weaver","title":"layout engine plan","age":"9m"},
{"threadId":"thr_backup","kind":"running","project":"homelab","title":"nightly backup cron","age":"12m"},
{"threadId":"thr_flaky","kind":"running","project":"resend-api","title":"flaky test sweep","age":"4m"},
{"threadId":"thr_arena","kind":"running","project":"weaver","title":"measure arena sizes","age":"1m"},
{"threadId":"thr_notes","kind":"done","project":"api","title":"ship release notes","age":"1h"},
{"threadId":"thr_deps","kind":"done","project":"web","title":"bump deps","age":"2h"},
{"threadId":"thr_footer","kind":"done","project":"web","title":"fix footer","age":"3h"},
{"threadId":"thr_keys","kind":"done","project":"api","title":"rotate keys","age":"5h"},
{"threadId":"thr_prune","kind":"done","project":"homelab","title":"prune images","age":"9h"}],
"counts":{"needs":2,"running":3,"done":5},"approvals":{"available":true},"warnings":[],"t3":"ok"})";

namespace {

const char kBouncePage[] = R"({"type":"thread_page","threadId":"thr_bounce","header":{"project":"resend-api","title":"fix bounce webhook","model":"Opus 5.5","status":"running"},"page":1,"pages":1,"lines":["Running the bounce tests now."]})";

const char kBounceRequest[] = R"({"type":"request","threadId":"thr_bounce","requestId":"req_1","kind":"approval",
"lines":["Wants to run a command:","  pnpm vitest run src/webhooks/","  bounce.test.ts --update","  cwd: worktrees/fix-bounce-webhook"],
"options":[{"key":"Y","label":"Allow once","value":"allow_once"},{"key":"A","label":"Always allow","value":"allow_always"},
{"key":"N","label":"Deny","value":"deny"},{"key":"T","label":"Deny, say why","value":"deny_with_reason"}]})";

const char kLayoutPage[] = R"({"type":"thread_page","threadId":"thr_layout","header":{"project":"weaver","title":"layout engine plan","model":"Opus 5.5","status":"running"},"page":1,"pages":1,"lines":["I have two layouts in mind."]})";

const char kLayoutRequest[] = R"({"type":"request","threadId":"thr_layout","requestId":"req_2","kind":"question",
"lines":["Which layout engine should I build?"],
"options":[{"key":"1","label":"flexbox subset","value":"flex"},{"key":"2","label":"grid subset","value":"grid"},{"key":"T","label":"Type answer","value":"text"}]})";

const char kArenaPage[] = R"({"type":"thread_page","threadId":"thr_arena","header":{"project":"weaver","title":"measure arena sizes","model":"Opus 5.5","status":"running"},
"page":1,"pages":3,"lines":["Measured 14 real widgets. Max nodes","seen was 212, so I set the tripwire","at 2048 and made the error name the","limit and the ask. All 38 tests pass.","PR #41 is open against main."]})";

const char kProjects[] = R"({"type":"projects","items":[
{"projectId":"proj_resend","name":"resend-api","defaults":{"model":"Opus 5.5","workspace":"worktree","runtimeMode":"auto"}},
{"projectId":"proj_weaver","name":"weaver","defaults":{"model":"Opus 5.5","workspace":"root","runtimeMode":"approval-required"}}]})";

std::string field(const cJSON *json, const char *name)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, name);
    return cJSON_IsString(item) ? item->valuestring : "";
}

std::string ack(const std::string &id, bool ok)
{
    return R"({"type":"ack","id":")" + id + (ok ? R"(","ok":true})" : R"(","ok":false,"error":"demo relay: no canned view for this"})");
}

}

std::vector<std::string> demo_relay_answer(std::string_view deviceFrame)
{
    cJSON *json = cJSON_ParseWithLength(deviceFrame.data(), deviceFrame.size());
    if (json == nullptr) {
        return {};
    }
    const std::string type = field(json, "type");
    const std::string id = field(json, "id");
    const std::string threadId = field(json, "threadId");
    cJSON_Delete(json);

    if (type == "open_thread" && threadId == "thr_bounce") {
        return {ack(id, true), kBouncePage, kBounceRequest};
    }
    if (type == "open_thread" && threadId == "thr_layout") {
        return {ack(id, true), kLayoutPage, kLayoutRequest};
    }
    if (type == "open_thread" && threadId == "thr_arena") {
        return {ack(id, true), kArenaPage};
    }
    if (type == "list_projects") {
        return {ack(id, true), kProjects};
    }
    if (type == "refresh") {
        return {ack(id, true), kDemoHome};
    }
    if (type == "respond" || type == "reply" || type == "launch") {
        return {ack(id, true)};
    }
    return {ack(id, false)};
}
