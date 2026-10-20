#include "doctest.h"

#include <cstdlib>
#include <fstream>
#include <set>
#include <string>
#include <vector>

#include "cJSON.h"
#include "t3/app.h"

namespace {

using t3::App;
using t3::Key;
using t3::KeyName;

const t3::HelloCaps kCaps{40, 8, 65536, 64};

const char *kHome = R"({"type":"home","rows":[
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

const char *kBouncePage = R"({"type":"thread_page","threadId":"thr_bounce","header":{"project":"resend-api","title":"fix bounce webhook","model":"Opus 5.5","status":"running"},"page":1,"pages":1,"lines":["Running the bounce tests now."]})";

const char *kBounceRequest = R"({"type":"request","threadId":"thr_bounce","requestId":"req_1","kind":"approval",
 "lines":["Wants to run a command:","  pnpm vitest run src/webhooks/","  bounce.test.ts --update","  cwd: worktrees/fix-bounce-webhook"],
 "options":[{"key":"Y","label":"Allow once","value":"allow_once"},{"key":"A","label":"Always allow","value":"allow_always"},
 {"key":"N","label":"Deny","value":"deny"},{"key":"T","label":"Deny, say why","value":"deny_with_reason"}]})";

const char *kWeaverHome = R"({"type":"home","rows":[{"threadId":"thr_weaver","kind":"done","project":"weaver","title":"layout engine","age":"2m"}],
 "counts":{"needs":0,"running":0,"done":1},"approvals":{"available":true},"warnings":[],"t3":"ok"})";

const char *kWeaverPage = R"({"type":"thread_page","threadId":"thr_weaver","header":{"project":"weaver","title":"layout engine","model":"Opus 5.5","status":"done"},
 "page":1,"pages":3,"lines":["Measured 14 real widgets. Max nodes","seen was 212, so I set the tripwire","at 2048 and made the error name the","limit and the ask. All 38 tests pass.","PR #41 is open against main."]})";

const char *kProjects = R"({"type":"projects","items":[
 {"projectId":"proj_resend","name":"resend-api","defaults":{"model":"Opus 5.5","workspace":"worktree","runtimeMode":"auto"}},
 {"projectId":"proj_weaver","name":"weaver","defaults":{"model":"Opus 5.5","workspace":"root","runtimeMode":"approval-required"}}]})";

uint32_t tick()
{
    static uint32_t now = 0;
    now += 1000;
    return now;
}

App::Out press(App &app, Key key)
{
    return app.onKey(key, tick());
}

App::Out push(App &app, const t3::RelayMsg &msg)
{
    return app.onRelay(msg, tick());
}

App::Out pushFrame(App &app, std::string_view json)
{
    return app.onFrame(json, tick());
}

t3::RelayMsg relay(const std::string &json)
{
    std::string err;
    const std::optional<t3::RelayMsg> msg = t3::parseRelay(json, kCaps, err);
    REQUIRE_MESSAGE(msg.has_value(), err);
    return *msg;
}

std::vector<std::string> rows(const App &app)
{
    t3::Grid grid;
    app.draw(grid);
    std::vector<std::string> out;
    for (int row = 0; row < t3::Grid::Rows; ++row) {
        out.push_back(grid.rowText(row));
    }
    return out;
}

std::string row(const App &app, int index)
{
    return rows(app)[index];
}

int selectedRow(const App &app)
{
    t3::Grid grid;
    app.draw(grid);
    for (int r = 0; r < t3::Grid::Rows; ++r) {
        if (grid.at(r, 0).sel) {
            return r;
        }
    }
    return -1;
}

std::string allText(const App &app)
{
    std::string text;
    for (const std::string &r : rows(app)) {
        text += r + "\n";
    }
    return text;
}

bool contains(const std::string &haystack, const std::string &needle)
{
    return haystack.find(needle) != std::string::npos;
}

void checkGolden(const App &app, const char *name)
{
    std::ifstream file(std::string(T3_REPO_ROOT) + "/firmware/test/host/golden/" + name + ".txt");
    REQUIRE(file.good());
    std::vector<std::string> want;
    for (std::string line; std::getline(file, line);) {
        REQUIRE_MESSAGE(line.size() == static_cast<size_t>(t3::Grid::Cols), name << " golden line is not 40 chars: '" << line << "'");
        want.push_back(line);
    }
    REQUIRE(want.size() == static_cast<size_t>(t3::Grid::Rows));
    const std::vector<std::string> got = rows(app);
    for (int r = 0; r < t3::Grid::Rows; ++r) {
        CHECK_MESSAGE(got[r] == want[r], name << " row " << r << "\n got: '" << got[r] << "'\nwant: '" << want[r] << "'");
    }
}

Key ch(char c)
{
    return Key{KeyName::Char, c};
}

Key named(KeyName name)
{
    return Key{name};
}

void type(App &app, const std::string &text)
{
    for (char c : text) {
        App::Out out = press(app, ch(c));
        CHECK(out.send.empty());
    }
}

struct Frame {
    explicit Frame(const std::string &text) : json(cJSON_Parse(text.c_str())) { REQUIRE(json != nullptr); }
    ~Frame() { cJSON_Delete(json); }
    Frame(const Frame &) = delete;
    Frame &operator=(const Frame &) = delete;

    bool has(const char *field) const { return cJSON_GetObjectItemCaseSensitive(json, field) != nullptr; }
    std::string str(const char *field) const
    {
        const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, field);
        return cJSON_IsString(item) ? item->valuestring : "";
    }
    int num(const char *field) const
    {
        const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, field);
        return cJSON_IsNumber(item) ? item->valueint : -1;
    }

    cJSON *json;
};

const std::string &only(const App::Out &out)
{
    REQUIRE(out.send.size() == 1);
    return out.send.front();
}

App live()
{
    App app(kCaps, 7);
    app.onLinkStatus("");
    return app;
}

App onApproval()
{
    App app = live();
    push(app, relay(kHome));
    const App::Out out = press(app, named(KeyName::Enter));
    const Frame open(only(out));
    CHECK(open.str("type") == "open_thread");
    CHECK(open.str("threadId") == "thr_bounce");
    push(app, relay(kBouncePage));
    push(app, relay(kBounceRequest));
    return app;
}

App onWeaverThread()
{
    App app = live();
    push(app, relay(kWeaverHome));
    press(app, named(KeyName::Enter));
    push(app, relay(kWeaverPage));
    return app;
}

App onQuestion(const std::string &request)
{
    App app = live();
    push(app, relay(R"({"type":"home","rows":[{"threadId":"thr_q","kind":"question","project":"weaver","title":"pick files","age":"1m"}],
 "counts":{"needs":1,"running":0,"done":0},"approvals":{"available":true},"warnings":[],"t3":"ok"})"));
    press(app, named(KeyName::Enter));
    push(app, relay(request));
    return app;
}

std::string homeJson(int needs, int running, int done, int needsCount, int runningCount, int doneCount)
{
    std::string rowsJson;
    auto add = [&](const char *kind, const char *label, int n) {
        for (int i = 1; i <= n; ++i) {
            if (!rowsJson.empty()) {
                rowsJson += ",";
            }
            const std::string id = std::string(label) + "-" + std::to_string(i);
            rowsJson += R"({"threadId":"thr_)" + id + R"(","kind":")" + kind + R"(","project":"p","title":")" + id + R"(","age":"1m"})";
        }
    };
    add("approval", "needs", needs);
    add("running", "running", running);
    add("done", "done", done);
    return R"({"type":"home","rows":[)" + rowsJson + R"(],"counts":{"needs":)" + std::to_string(needsCount) + R"(,"running":)" +
           std::to_string(runningCount) + R"(,"done":)" + std::to_string(doneCount) +
           R"(},"approvals":{"available":true},"warnings":[],"t3":"ok"})";
}

void *failAllocate(size_t)
{
    return nullptr;
}

void ignoreRelease(void *) {}

struct FailingAllocator {
    FailingAllocator() { t3::setJsonAllocator({failAllocate, ignoreRelease}); }
    ~FailingAllocator() { t3::setJsonAllocator({std::malloc, std::free}); }
};

}

TEST_CASE("home matches mockup 1 for its example home")
{
    App app = live();
    push(app, relay(kHome));
    CHECK(app.screenName() == "home");
    checkGolden(app, "home");
    CHECK(selectedRow(app) == 2);
}

TEST_CASE("approval matches mockup 2")
{
    const App app = onApproval();
    CHECK(app.screenName() == "approval");
    checkGolden(app, "approval");
}

TEST_CASE("thread matches mockup 3")
{
    const App app = onWeaverThread();
    CHECK(app.screenName() == "thread");
    checkGolden(app, "thread");
    CHECK(selectedRow(app) == 8);
}

TEST_CASE("new task matches mockup 5")
{
    App app = live();
    push(app, relay(kHome));
    const Frame list(only(press(app, ch('N'))));
    CHECK(list.str("type") == "list_projects");
    push(app, relay(kProjects));
    CHECK(app.screenName() == "projects");
    CHECK(press(app, named(KeyName::Enter)).send.empty());
    CHECK(app.screenName() == "new_task");
    type(app, "the bounce webhook drops events when the payload has no tags. find why and open a PR");
    checkGolden(app, "newtask");
}

TEST_CASE("Y on approval sends respond allow_once with a fresh id")
{
    App app = onApproval();
    const Frame first(only(press(app, ch('Y'))));
    CHECK(first.str("type") == "respond");
    CHECK(first.str("threadId") == "thr_bounce");
    CHECK(first.str("requestId") == "req_1");
    CHECK(first.str("value") == "allow_once");
    CHECK_FALSE(first.has("text"));
    CHECK_FALSE(first.str("id").empty());

    std::string next = kBounceRequest;
    next.replace(next.find("req_1"), 5, "req_2");
    push(app, relay(next));
    CHECK(app.screenName() == "approval");
    const Frame second(only(press(app, ch('y'))));
    CHECK(second.str("requestId") == "req_2");
    CHECK(second.str("value") == "allow_once");
    CHECK(second.str("id") != first.str("id"));
}

TEST_CASE("Fn+Enter sends reply mode steer")
{
    App app = onWeaverThread();
    type(app, "ship it");
    CHECK(row(app, 8).rfind("> ship it_", 0) == 0);
    const Frame steer(only(press(app, named(KeyName::FnEnter))));
    CHECK(steer.str("type") == "reply");
    CHECK(steer.str("threadId") == "thr_weaver");
    CHECK(steer.str("text") == "ship it");
    CHECK(steer.str("mode") == "steer");

    type(app, "and add a test");
    const Frame queue(only(press(app, named(KeyName::Enter))));
    CHECK(queue.str("text") == "and add a test");
    CHECK(queue.str("mode") == "queue");
    CHECK(queue.str("id") != steer.str("id"));
}

TEST_CASE("12-option multiSelect question scrolls body and keeps all options reachable")
{
    std::string options;
    for (int i = 1; i <= 9; ++i) {
        options += R"({"key":")" + std::to_string(i) + R"(","label":"file-)" + std::to_string(i) + R"(.ts","value":"f)" + std::to_string(i) + R"("},)";
    }
    options += R"({"key":"T","label":"Type answer","value":"text"})";
    App app = onQuestion(R"j({"type":"request","threadId":"thr_q","requestId":"req_q","kind":"question",
 "lines":["Which files should I touch?","(showing 9 of 12 options, T to type","another)","(pick one)"],"options":[)j" + options + "]}");
    CHECK(app.screenName() == "question");
    CHECK(row(app, 1).rfind("Which files should I touch?", 0) == 0);
    CHECK(contains(row(app, 10), "^v"));

    std::set<std::string> seen;
    bool scrolled = false;
    for (int i = 0; i < 20; ++i) {
        for (const std::string &r : rows(app)) {
            seen.insert(r.substr(0, r.find_last_not_of(' ') + 1));
        }
        CHECK(press(app, named(KeyName::Down)).send.empty());
        scrolled = scrolled || row(app, 1).rfind("Which files", 0) != 0;
    }
    CHECK(scrolled);
    for (int i = 1; i <= 9; ++i) {
        CHECK_MESSAGE(seen.count("[" + std::to_string(i) + "] file-" + std::to_string(i) + ".ts") == 1, "option " << i);
    }
    CHECK(seen.count("[T] Type answer") == 1);
    CHECK(seen.count("Which files should I touch?") == 1);
    CHECK(seen.count("(pick one)") == 1);

    for (int i = 0; i < 20; ++i) {
        press(app, named(KeyName::Up));
    }
    CHECK(row(app, 1).rfind("Which files should I touch?", 0) == 0);

    const Frame pick(only(press(app, ch('9'))));
    CHECK(pick.str("value") == "f9");
    CHECK(pick.str("requestId") == "req_q");
}

TEST_CASE("an approval taller than the screen scrolls its body and keeps every option pinned")
{
    App app = live();
    push(app, relay(kHome));
    press(app, named(KeyName::Enter));
    push(app, relay(R"({"type":"request","threadId":"thr_bounce","requestId":"req_t","kind":"approval",
 "lines":["line 1","line 2","line 3","line 4","line 5","line 6","line 7","line 8"],
 "options":[{"key":"Y","label":"Allow once","value":"allow_once"},{"key":"A","label":"Always allow","value":"allow_always"},
 {"key":"N","label":"Deny","value":"deny"},{"key":"T","label":"Deny, say why","value":"deny_with_reason"}]})"));
    CHECK(contains(row(app, 10), "^v"));
    std::set<std::string> lines;
    for (int i = 0; i < 10; ++i) {
        const std::vector<std::string> shown = rows(app);
        CHECK(shown[6].rfind("[Y] Allow once", 0) == 0);
        CHECK(shown[7].rfind("[A] Always allow", 0) == 0);
        CHECK(shown[8].rfind("[N] Deny", 0) == 0);
        CHECK(shown[9].rfind("[T] Deny, say why", 0) == 0);
        for (int r = 1; r <= 5; ++r) {
            lines.insert(shown[r].substr(0, shown[r].find_last_not_of(' ') + 1));
        }
        press(app, named(KeyName::Down));
    }
    for (int i = 1; i <= 8; ++i) {
        CHECK_MESSAGE(lines.count("line " + std::to_string(i)) == 1, "line " << i);
    }
}

TEST_CASE("home with 30 rows scrolls and needs stay on top")
{
    App app = live();
    push(app, relay(homeJson(10, 10, 10, 10, 10, 10)));
    CHECK(row(app, 1).rfind("NEEDS YOU (10)", 0) == 0);
    CHECK(selectedRow(app) == 2);
    CHECK(row(app, 2).rfind("! p needs-1 ", 0) == 0);

    std::set<std::string> selected;
    std::set<std::string> seen;
    for (int i = 0; i < 35; ++i) {
        const std::vector<std::string> shown = rows(app);
        seen.insert(shown.begin(), shown.end());
        const int sel = selectedRow(app);
        REQUIRE(sel >= 1);
        REQUIRE(sel <= 9);
        selected.insert(shown[sel].substr(4, shown[sel].find(' ', 4) - 4));
        press(app, named(KeyName::Down));
    }
    CHECK(selected.size() == 30);
    CHECK(selected.count("done-10") == 1);
    auto seenHeader = [&](const std::string &header) {
        for (const std::string &r : seen) {
            if (r.rfind(header, 0) == 0) {
                return true;
            }
        }
        return false;
    };
    CHECK(seenHeader("RUNNING (10)"));
    CHECK(seenHeader("DONE TODAY (10)"));

    const Frame open(only(press(app, named(KeyName::Enter))));
    CHECK(open.str("threadId") == "thr_done-10");

    App back = live();
    push(back, relay(homeJson(10, 10, 10, 10, 10, 10)));
    for (int i = 0; i < 29; ++i) {
        press(back, named(KeyName::Down));
    }
    for (int i = 0; i < 29; ++i) {
        press(back, named(KeyName::Up));
    }
    CHECK(row(back, 1).rfind("NEEDS YOU (10)", 0) == 0);
    CHECK(selectedRow(back) == 2);
}

TEST_CASE("a home update keeps the selection on the same thread")
{
    App app = live();
    push(app, relay(kHome));
    press(app, named(KeyName::Down));
    press(app, named(KeyName::Down));
    CHECK(contains(row(app, selectedRow(app)), "nightly backup cron"));
    std::string moved = kHome;
    moved.insert(moved.find(R"({"threadId":"thr_bounce")"), R"({"threadId":"thr_new","kind":"approval","project":"api","title":"new approval","age":"0s"},)");
    moved.replace(moved.find(R"("needs":2)"), 9, R"("needs":3)");
    push(app, relay(moved));
    CHECK(contains(row(app, selectedRow(app)), "nightly backup cron"));
    push(app, relay(homeJson(3, 0, 0, 3, 0, 0)));
    CHECK(contains(row(app, selectedRow(app)), "needs-3"));
}

TEST_CASE("home counts that exceed the rows name maxHomeRows")
{
    App app(t3::HelloCaps{40, 8, 65536, 8}, 7);
    app.onLinkStatus("");
    push(app, relay(homeJson(2, 3, 3, 2, 3, 5)));
    std::string seen;
    for (int i = 0; i < 10; ++i) {
        seen += allText(app);
        press(app, named(KeyName::Down));
    }
    CHECK(contains(seen, "DONE TODAY (5)"));
    CHECK(contains(seen, "maxHomeRows=8, home needed 10"));
}

TEST_CASE("R sends refresh")
{
    App app = live();
    push(app, relay(kHome));
    const Frame upper(only(press(app, ch('R'))));
    CHECK(upper.str("type") == "refresh");
    const Frame lower(only(press(app, ch('r'))));
    CHECK(lower.str("type") == "refresh");
    CHECK(lower.str("id") != upper.str("id"));
}

TEST_CASE("T on approval sends respond with text")
{
    App app = onApproval();
    CHECK(press(app, ch('T')).send.empty());
    type(app, "use staging");
    CHECK(row(app, 9).rfind("> use staging_", 0) == 0);
    const Frame respond(only(press(app, named(KeyName::Enter))));
    CHECK(respond.str("type") == "respond");
    CHECK(respond.str("value") == "deny_with_reason");
    CHECK(respond.str("text") == "use staging");
    CHECK(respond.str("requestId") == "req_1");
}

TEST_CASE("a question with no options takes free text")
{
    App app = onQuestion(R"({"type":"request","threadId":"thr_q","requestId":"req_f","kind":"question","lines":["Why did the test fail?"],"options":[]})");
    CHECK(row(app, 9).rfind("> _", 0) == 0);
    type(app, "flaky clock");
    const Frame respond(only(press(app, named(KeyName::Enter))));
    CHECK(respond.str("value") == "text");
    CHECK(respond.str("text") == "flaky clock");
}

TEST_CASE("a refused respond goes back to the request and says why")
{
    App app = onApproval();
    const Frame sent(only(press(app, ch('N'))));
    CHECK(app.screenName() == "thread");
    push(app, t3::Ack{sent.str("id"), false, std::string("request no longer pending")});
    CHECK(app.screenName() == "approval");
    CHECK(row(app, 0).rfind("refused: request no longer pending", 0) == 0);
}

TEST_CASE("thread pages with up and down, backspace on an empty line goes home")
{
    App app = onWeaverThread();
    CHECK(press(app, named(KeyName::Up)).send.empty());
    const Frame page(only(press(app, named(KeyName::Down))));
    CHECK(page.str("type") == "page");
    CHECK(page.str("threadId") == "thr_weaver");
    CHECK(page.num("page") == 2);
    type(app, "ab");
    press(app, named(KeyName::Backspace));
    press(app, named(KeyName::Backspace));
    CHECK(app.screenName() == "thread");
    press(app, named(KeyName::Backspace));
    CHECK(app.screenName() == "home");
}

TEST_CASE("a truncated reply names its budget")
{
    App app = live();
    push(app, relay(kWeaverHome));
    press(app, named(KeyName::Enter));
    push(app, relay(R"({"type":"thread_page","threadId":"thr_weaver","header":{"project":"weaver","title":"layout engine","model":"Opus 5.5","status":"done"},"page":32,"pages":32,"lines":["...end of what fits..."],"truncated":{"budget":"max_reply_pages","limit":32,"actual":57}})"));
    CHECK(contains(row(app, 1), "max_reply_pages=32, reply needed 57"));
}

TEST_CASE("new task cycles workspace and mode with tab and launches with them")
{
    App app = live();
    push(app, relay(kHome));
    press(app, ch('n'));
    push(app, relay(R"({"type":"projects","items":[
 {"projectId":"proj_resend","name":"resend-api","defaults":{"model":"Opus 5.5","workspace":"worktree","runtimeMode":"auto"}}],
 "truncated":{"budget":"maxHomeRows","limit":1,"actual":40,"hidden":39}})"));
    std::string shown;
    for (const std::string &r : rows(app)) {
        shown += r.substr(0, r.find_last_not_of(' ') + 1) + " ";
    }
    CHECK(contains(shown, "+39 more projects: maxHomeRows=1, needed 40"));

    press(app, named(KeyName::Enter));
    press(app, named(KeyName::Tab));
    CHECK(contains(row(app, 3), "[new worktree]"));
    press(app, named(KeyName::Right));
    CHECK(contains(row(app, 3), "[root]"));
    press(app, named(KeyName::Tab));
    CHECK(contains(row(app, 4), "[auto]"));
    press(app, named(KeyName::Right));
    CHECK(contains(row(app, 4), "[full-access]"));

    CHECK(press(app, named(KeyName::Enter)).send.empty());
    CHECK(contains(row(app, 0), "prompt"));
    type(app, "go");
    const Frame launch(only(press(app, named(KeyName::Enter))));
    CHECK(launch.str("type") == "launch");
    CHECK(launch.str("projectId") == "proj_resend");
    CHECK(launch.str("text") == "go");
    CHECK(launch.str("workspace") == "root");
    CHECK(launch.str("runtimeMode") == "full-access");
    CHECK_FALSE(launch.has("model"));

    push(app, t3::Ack{launch.str("id"), true, std::nullopt});
    CHECK(app.screenName() == "home");
    CHECK(row(app, 0).rfind("task launched", 0) == 0);
}

TEST_CASE("every parse failure reaches the status bar")
{
    App app = live();
    pushFrame(app, kHome);
    CHECK(app.screenName() == "home");
    pushFrame(app, "{not json");
    CHECK(row(app, 0).rfind("frame: not valid json", 0) == 0);
    CHECK(app.screenName() == "home");
}

TEST_CASE("an unknown home kind draws a ? row instead of blanking home")
{
    App app = live();
    push(app, relay(R"({"type":"home","rows":[{"threadId":"thr_x","kind":"paused","project":"api","title":"later","age":"1m"}],
 "counts":{"needs":1,"running":0,"done":0},"approvals":{"available":true},"warnings":[],"t3":"ok"})"));
    CHECK(contains(allText(app), "? api later"));
}

TEST_CASE("an encoder out of memory sends nothing, says so, and keeps the screen usable")
{
    App app = live();
    push(app, relay(kHome));
    {
        FailingAllocator failing;
        CHECK(press(app, ch('R')).send.empty());
    }
    CHECK(contains(row(app, 0), "refresh"));
    CHECK(contains(row(app, 0), "memory"));
    CHECK(app.screenName() == "home");
    CHECK(Frame(only(press(app, ch('R')))).str("type") == "refresh");
}

TEST_CASE("row 0 shows the link status until welcome and when the link drops")
{
    App app(kCaps, 7);
    CHECK(app.screenName() == "connecting");
    app.onLinkStatus("connecting");
    CHECK(row(app, 0).rfind("connecting", 0) == 0);
    app.onLinkStatus("");
    CHECK(app.screenName() == "connecting");
    CHECK(contains(allText(app), "waiting for home"));
    push(app, relay(kHome));
    CHECK(row(app, 0).rfind("T3", 0) == 0);
    app.onLinkStatus("relay unreachable: closed 1006");
    CHECK(row(app, 0).rfind("relay unreachable: closed 1006", 0) == 0);
    CHECK(app.screenName() == "home");
}

TEST_CASE("coming back online with a thread open reopens it")
{
    App app = onWeaverThread();
    CHECK(app.onLinkStatus("relay unreachable: closed 1006").send.empty());
    const Frame open(only(app.onLinkStatus("")));
    CHECK(open.str("type") == "open_thread");
    CHECK(open.str("threadId") == "thr_weaver");
}

TEST_CASE("approvals down: row 0 says so, home shows the reason, approval keys send nothing")
{
    std::string home = kHome;
    home.replace(home.find(R"("approvals":{"available":true})"), 30, R"("approvals":{"available":false,"reason":"approvals down: adapter broken"})");
    App app = live();
    push(app, relay(home));
    CHECK(contains(row(app, 0), "approvals down"));
    CHECK(contains(allText(app), "approvals down: adapter broken"));
    press(app, named(KeyName::Enter));
    push(app, relay(kBouncePage));
    push(app, relay(kBounceRequest));
    CHECK(press(app, ch('Y')).send.empty());
    CHECK(contains(row(app, 0), "approvals down: adapter broken"));
}

TEST_CASE("warnings, T3 state and error frames show as given")
{
    std::string home = kHome;
    home.replace(home.find(R"("warnings":[])"), 13, R"("warnings":["T3 token expires in 3 days, run t3-cardputer-relay login on the relay host"])");
    home.replace(home.find(R"("t3":"ok")"), 9, R"("t3":"unreachable")");
    App app = live();
    push(app, relay(home));
    CHECK(contains(row(app, 0), "T3 unreachable"));
    std::string body;
    for (const std::string &r : rows(app)) {
        body += r.substr(0, r.find_last_not_of(' ') + 1) + " ";
    }
    CHECK(contains(body, "T3 token expires in 3 days, run t3-cardputer-relay login on the relay host"));

    const std::string message = "max_frame_bytes=4096, request for thr_bounce needed 5120 bytes, the relay sent this error instead";
    push(app, t3::Error{t3::ErrorCode::Internal, message});
    const std::vector<std::string> wrapped = t3::wrapWords(message, t3::Grid::Cols);
    REQUIRE(wrapped.size() == 3);
    for (size_t i = 0; i < wrapped.size(); ++i) {
        CHECK(row(app, static_cast<int>(i)).rfind(wrapped[i], 0) == 0);
    }
}

TEST_CASE("a refused request says why on row 0")
{
    App app = live();
    push(app, relay(kHome));
    const Frame refresh(only(press(app, ch('R'))));
    push(app, t3::Ack{refresh.str("id"), false, std::string("T3 unreachable")});
    CHECK(row(app, 0).rfind("refused: T3 unreachable", 0) == 0);
}

TEST_CASE("wrapWords breaks at spaces and hard-cuts long words")
{
    CHECK(t3::wrapWords("one two three", 7) == std::vector<std::string>{"one two", "three"});
    CHECK(t3::wrapWords("abcdefghij", 4) == std::vector<std::string>{"abcd", "efgh", "ij"});
    CHECK(t3::wrapWords("", 4) == std::vector<std::string>{""});
}

TEST_CASE("the same request sent again keeps a half-typed reason")
{
    App app = onApproval();
    press(app, ch('T'));
    type(app, "abc");
    push(app, relay(kBounceRequest));
    CHECK(row(app, 9).rfind("> abc_", 0) == 0);
}

TEST_CASE("a request pushed while a reply is being typed waits for Tab")
{
    App app = onWeaverThread();
    type(app, "go ");
    std::string request = kBounceRequest;
    request.replace(request.find("thr_bounce"), 10, "thr_weaver");
    push(app, relay(request));
    CHECK(app.screenName() == "thread");
    type(app, "ahead");
    CHECK(row(app, 8).rfind("> go ahead_", 0) == 0);
    CHECK(contains(row(app, 10), "Tab request"));
    CHECK(press(app, named(KeyName::Tab)).send.empty());
    CHECK(app.screenName() == "approval");
    const Frame respond(only(press(app, ch('Y'))));
    CHECK(respond.str("value") == "allow_once");
    press(app, named(KeyName::Esc));
}

TEST_CASE("a different request pushed while a reason is being typed waits, the reason stays")
{
    App app = onApproval();
    press(app, ch('T'));
    type(app, "abc");
    std::string next = kBounceRequest;
    next.replace(next.find("req_1"), 5, "req_2");
    push(app, relay(next));
    CHECK(row(app, 9).rfind("> abc_", 0) == 0);
    CHECK(contains(row(app, 10), "Tab request"));
    const Frame respond(only(press(app, named(KeyName::Enter))));
    CHECK(respond.str("requestId") == "req_1");
    CHECK(respond.str("text") == "abc");
}

TEST_CASE("option keys wait kRequestGuardMs after a pushed request replaces the screen")
{
    App app = live();
    app.onRelay(relay(kHome), 0);
    app.onKey(named(KeyName::Enter), 10);
    app.onRelay(relay(kBouncePage), 20);
    app.onRelay(relay(kBounceRequest), 1000);
    CHECK(app.screenName() == "approval");
    CHECK(app.onKey(named(KeyName::Enter), 1100).send.empty());
    CHECK(app.screenName() == "approval");
    const uint32_t lastSwallowed = 1100 + t3::kRequestGuardMs - 1;
    CHECK(app.onKey(ch('Y'), lastSwallowed).send.empty());
    CHECK(contains(row(app, 0), "just arrived"));
    const Frame respond(only(app.onKey(ch('Y'), lastSwallowed + t3::kRequestGuardMs)));
    CHECK(respond.str("value") == "allow_once");
}

TEST_CASE("a failed reply goes back only to its own thread")
{
    App app = live();
    push(app, relay(kHome));
    for (int i = 0; i < 4; ++i) {
        press(app, named(KeyName::Down));
    }
    press(app, named(KeyName::Enter));
    type(app, "hello");
    const Frame reply(only(press(app, named(KeyName::Enter))));
    CHECK(reply.str("threadId") == "thr_arena");
    press(app, named(KeyName::Backspace));
    press(app, named(KeyName::Up));
    press(app, named(KeyName::Enter));
    push(app, t3::Ack{reply.str("id"), false, std::string("T3 down")});
    CHECK(row(app, 0).rfind("reply to measure arena sizes failed: T3", 0) == 0);
    CHECK(row(app, 1).rfind("down ", 0) == 0);
    CHECK(press(app, named(KeyName::Enter)).send.empty());

    App same = onWeaverThread();
    type(same, "again");
    const Frame first(only(press(same, named(KeyName::Enter))));
    push(same, t3::Ack{first.str("id"), false, std::string("T3 down")});
    CHECK(row(same, 8).rfind("> again_", 0) == 0);
}

TEST_CASE("a failed respond for a thread no longer open is a notice, not a screen change")
{
    App app = onApproval();
    const Frame sent(only(press(app, ch('N'))));
    press(app, named(KeyName::Esc));
    press(app, named(KeyName::Down));
    press(app, named(KeyName::Enter));
    CHECK(app.screenName() == "thread");
    push(app, t3::Ack{sent.str("id"), false, std::string("request no longer pending")});
    CHECK(app.screenName() == "thread");
    CHECK(row(app, 0).rfind("answer to fix bounce webhook failed:", 0) == 0);
    CHECK(row(app, 1).rfind("request no longer pending", 0) == 0);
}

TEST_CASE("enter twice on new task launches once, a refused launch keeps the prompt")
{
    App app = live();
    push(app, relay(kHome));
    press(app, ch('N'));
    push(app, relay(kProjects));
    press(app, named(KeyName::Enter));
    type(app, "go");
    const Frame launch(only(press(app, named(KeyName::Enter))));
    CHECK(press(app, named(KeyName::Enter)).send.empty());
    CHECK(row(app, 0).rfind("starting...", 0) == 0);
    push(app, t3::Ack{launch.str("id"), false, std::string("T3 down")});
    CHECK(app.screenName() == "new_task");
    CHECK(row(app, 6).rfind("> go_", 0) == 0);
    const Frame retry(only(press(app, named(KeyName::Enter))));
    CHECK(retry.str("text") == "go");
    CHECK(retry.str("id") != launch.str("id"));
}

TEST_CASE("new task shows every workspace and mode value in full")
{
    App app = live();
    push(app, relay(kHome));
    press(app, ch('N'));
    push(app, relay(R"({"type":"projects","items":[
 {"projectId":"proj_long","name":"a-project-name-that-is-long","defaults":{"model":"claude-opus-4-5-20251101","workspace":"worktree","runtimeMode":"approval-required"}}]})"));
    press(app, named(KeyName::Enter));
    CHECK(row(app, 2).rfind("model     claude-opus-4-5-20251101", 0) == 0);
    press(app, named(KeyName::Tab));
    CHECK(row(app, 3).rfind("workspace [new worktree]", 0) == 0);
    press(app, named(KeyName::Tab));
    for (const char *mode : {"approval-required", "auto-accept-edits", "auto", "full-access"}) {
        CHECK(row(app, 4).rfind(std::string("mode      [") + mode + "]", 0) == 0);
        press(app, named(KeyName::Right));
    }
}

namespace {

App weaverThreadAt(uint32_t &t)
{
    App app = live();
    app.onRelay(relay(kWeaverHome), t);
    app.onKey(named(KeyName::Enter), t += 1000);
    app.onRelay(relay(kWeaverPage), t += 1000);
    t += 1000;
    return app;
}

t3::RelayMsg weaverRequest(const std::string &requestId, const std::string &firstLine = "Wants to run a command:")
{
    std::string json = kBounceRequest;
    json.replace(json.find("thr_bounce"), 10, "thr_weaver");
    json.replace(json.find("req_1"), 5, requestId);
    json.replace(json.find("Wants to run a command:"), 23, firstLine);
    return relay(json);
}

size_t typeAt(App &app, const std::string &text, uint32_t &t, uint32_t step)
{
    size_t sent = 0;
    for (char c : text) {
        sent += app.onKey(ch(c), t).send.size();
        t += step;
    }
    return sent;
}

std::string idOf(const App::Out &out)
{
    return Frame(only(out)).str("id");
}

}

TEST_CASE("probe B: a typing burst after a pushed request never reaches an option")
{
    uint32_t t = 0;
    App app = weaverThreadAt(t);
    app.onRelay(weaverRequest("r1"), t);
    t += 50;
    CHECK(typeAt(app, "now add a test", t, 100) == 0);
    CHECK(app.screenName() == "approval");
    t += t3::kRequestGuardMs;
    CHECK(Frame(only(app.onKey(ch('Y'), t))).str("value") == "allow_once");
}

TEST_CASE("probe C: an open reason line, even empty, holds a pushed request")
{
    uint32_t t = 0;
    App app = weaverThreadAt(t);
    app.onRelay(weaverRequest("r1"), t);
    app.onKey(ch('T'), t += 1000);
    app.onRelay(weaverRequest("r2"), t += 50);
    t += 50;
    CHECK(typeAt(app, "because x", t, 100) == 0);
    CHECK(row(app, 9).rfind("> because x_", 0) == 0);
    const Frame respond(only(app.onKey(named(KeyName::Enter), t)));
    CHECK(respond.str("requestId") == "r1");
    CHECK(respond.str("text") == "because x");
}

TEST_CASE("probe D: a failed respond while a reply is typed holds the request")
{
    uint32_t t = 0;
    App app = weaverThreadAt(t);
    app.onRelay(weaverRequest("r1"), t);
    const std::string id = idOf(app.onKey(ch('N'), t += 1000));
    CHECK(app.screenName() == "thread");
    t += 500;
    CHECK(typeAt(app, "ok n", t, 100) == 0);
    app.onRelay(t3::Ack{id, false, std::string("t3 blip")}, t);
    CHECK(app.screenName() == "thread");
    CHECK(row(app, 0).rfind("refused: t3 blip, Tab reopens it", 0) == 0);
    CHECK(typeAt(app, "ow add", t, 100) == 0);
    CHECK(row(app, 8).rfind("> ok now add_", 0) == 0);
    CHECK(contains(row(app, 10), "Tab request"));
    app.onKey(named(KeyName::Tab), t);
    CHECK(app.screenName() == "approval");
}

TEST_CASE("probe E: a failed respond never replaces a different request on screen")
{
    uint32_t t = 0;
    App app = weaverThreadAt(t);
    app.onRelay(weaverRequest("r1"), t);
    const std::string id = idOf(app.onKey(ch('N'), t += 1000));
    app.onRelay(weaverRequest("r2"), t += 100);
    app.onRelay(t3::Ack{id, false, std::string("t3 blip")}, t += 1000);
    CHECK(app.screenName() == "approval");
    CHECK(row(app, 0).rfind("answer to layout engine failed: t3 blip", 0) == 0);
    CHECK(Frame(only(app.onKey(ch('Y'), t += 100))).str("requestId") == "r2");
}

TEST_CASE("probe F: a launch whose ack is lost does not lock new task")
{
    App app = live();
    push(app, relay(kHome));
    press(app, ch('N'));
    push(app, relay(kProjects));
    press(app, named(KeyName::Enter));
    type(app, "go");
    const std::string first = idOf(press(app, named(KeyName::Enter)));
    app.onLinkStatus("relay unreachable: closed 1006");
    CHECK(row(app, 0).rfind("launch result unknown, check Home", 0) == 0);
    app.onLinkStatus("");
    CHECK(idOf(press(app, named(KeyName::Enter))) != first);

    press(app, named(KeyName::Esc));
    press(app, named(KeyName::Esc));
    CHECK(app.screenName() == "home");
    press(app, ch('N'));
    push(app, relay(kProjects));
    press(app, named(KeyName::Enter));
    type(app, "again");
    CHECK(Frame(only(press(app, named(KeyName::Enter)))).str("text") == "again");
}

TEST_CASE("probe I: answering a request drops its waiting copy, so Tab cannot answer it twice")
{
    uint32_t t = 0;
    App app = weaverThreadAt(t);
    app.onRelay(weaverRequest("r1"), t);
    app.onKey(ch('T'), t += 1000);
    t += 100;
    typeAt(app, "no", t, 100);
    app.onRelay(weaverRequest("r1", "Run r1 now?"), t += 500);
    CHECK(Frame(only(app.onKey(named(KeyName::Enter), t += 500))).str("requestId") == "r1");
    CHECK(app.onKey(named(KeyName::Tab), t += 500).send.empty());
    CHECK(app.screenName() == "thread");
}
