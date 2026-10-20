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
        App::Out out = app.onKey(ch(c));
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
    app.onRelay(relay(kHome));
    const App::Out out = app.onKey(named(KeyName::Enter));
    const Frame open(only(out));
    CHECK(open.str("type") == "open_thread");
    CHECK(open.str("threadId") == "thr_bounce");
    app.onRelay(relay(kBouncePage));
    app.onRelay(relay(kBounceRequest));
    return app;
}

App onWeaverThread()
{
    App app = live();
    app.onRelay(relay(kWeaverHome));
    app.onKey(named(KeyName::Enter));
    app.onRelay(relay(kWeaverPage));
    return app;
}

App onQuestion(const std::string &request)
{
    App app = live();
    app.onRelay(relay(R"({"type":"home","rows":[{"threadId":"thr_q","kind":"question","project":"weaver","title":"pick files","age":"1m"}],
 "counts":{"needs":1,"running":0,"done":0},"approvals":{"available":true},"warnings":[],"t3":"ok"})"));
    app.onKey(named(KeyName::Enter));
    app.onRelay(relay(request));
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
    app.onRelay(relay(kHome));
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
    app.onRelay(relay(kHome));
    const Frame list(only(app.onKey(ch('N'))));
    CHECK(list.str("type") == "list_projects");
    app.onRelay(relay(kProjects));
    CHECK(app.screenName() == "projects");
    CHECK(app.onKey(named(KeyName::Enter)).send.empty());
    CHECK(app.screenName() == "new_task");
    type(app, "the bounce webhook drops events when the payload has no tags. find why and open a PR");
    checkGolden(app, "newtask");
}

TEST_CASE("Y on approval sends respond allow_once with a fresh id")
{
    App app = onApproval();
    const Frame first(only(app.onKey(ch('Y'))));
    CHECK(first.str("type") == "respond");
    CHECK(first.str("threadId") == "thr_bounce");
    CHECK(first.str("requestId") == "req_1");
    CHECK(first.str("value") == "allow_once");
    CHECK_FALSE(first.has("text"));
    CHECK_FALSE(first.str("id").empty());

    std::string next = kBounceRequest;
    next.replace(next.find("req_1"), 5, "req_2");
    app.onRelay(relay(next));
    CHECK(app.screenName() == "approval");
    const Frame second(only(app.onKey(ch('y'))));
    CHECK(second.str("requestId") == "req_2");
    CHECK(second.str("value") == "allow_once");
    CHECK(second.str("id") != first.str("id"));
}

TEST_CASE("Fn+Enter sends reply mode steer")
{
    App app = onWeaverThread();
    type(app, "ship it");
    CHECK(row(app, 8).rfind("> ship it_", 0) == 0);
    const Frame steer(only(app.onKey(named(KeyName::FnEnter))));
    CHECK(steer.str("type") == "reply");
    CHECK(steer.str("threadId") == "thr_weaver");
    CHECK(steer.str("text") == "ship it");
    CHECK(steer.str("mode") == "steer");

    type(app, "and add a test");
    const Frame queue(only(app.onKey(named(KeyName::Enter))));
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
        CHECK(app.onKey(named(KeyName::Down)).send.empty());
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
        app.onKey(named(KeyName::Up));
    }
    CHECK(row(app, 1).rfind("Which files should I touch?", 0) == 0);

    const Frame pick(only(app.onKey(ch('9'))));
    CHECK(pick.str("value") == "f9");
    CHECK(pick.str("requestId") == "req_q");
}

TEST_CASE("an approval taller than the screen scrolls its body and keeps every option pinned")
{
    App app = live();
    app.onRelay(relay(kHome));
    app.onKey(named(KeyName::Enter));
    app.onRelay(relay(R"({"type":"request","threadId":"thr_bounce","requestId":"req_t","kind":"approval",
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
        app.onKey(named(KeyName::Down));
    }
    for (int i = 1; i <= 8; ++i) {
        CHECK_MESSAGE(lines.count("line " + std::to_string(i)) == 1, "line " << i);
    }
}

TEST_CASE("home with 30 rows scrolls and needs stay on top")
{
    App app = live();
    app.onRelay(relay(homeJson(10, 10, 10, 10, 10, 10)));
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
        app.onKey(named(KeyName::Down));
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

    const Frame open(only(app.onKey(named(KeyName::Enter))));
    CHECK(open.str("threadId") == "thr_done-10");

    App back = live();
    back.onRelay(relay(homeJson(10, 10, 10, 10, 10, 10)));
    for (int i = 0; i < 29; ++i) {
        back.onKey(named(KeyName::Down));
    }
    for (int i = 0; i < 29; ++i) {
        back.onKey(named(KeyName::Up));
    }
    CHECK(row(back, 1).rfind("NEEDS YOU (10)", 0) == 0);
    CHECK(selectedRow(back) == 2);
}

TEST_CASE("a home update keeps the selection on the same thread")
{
    App app = live();
    app.onRelay(relay(kHome));
    app.onKey(named(KeyName::Down));
    app.onKey(named(KeyName::Down));
    CHECK(contains(row(app, selectedRow(app)), "nightly backup cron"));
    std::string moved = kHome;
    moved.insert(moved.find(R"({"threadId":"thr_bounce")"), R"({"threadId":"thr_new","kind":"approval","project":"api","title":"new approval","age":"0s"},)");
    moved.replace(moved.find(R"("needs":2)"), 9, R"("needs":3)");
    app.onRelay(relay(moved));
    CHECK(contains(row(app, selectedRow(app)), "nightly backup cron"));
    app.onRelay(relay(homeJson(3, 0, 0, 3, 0, 0)));
    CHECK(contains(row(app, selectedRow(app)), "needs-3"));
}

TEST_CASE("home counts that exceed the rows name maxHomeRows")
{
    App app(t3::HelloCaps{40, 8, 65536, 8}, 7);
    app.onLinkStatus("");
    app.onRelay(relay(homeJson(2, 3, 3, 2, 3, 5)));
    std::string seen;
    for (int i = 0; i < 10; ++i) {
        seen += allText(app);
        app.onKey(named(KeyName::Down));
    }
    CHECK(contains(seen, "DONE TODAY (5)"));
    CHECK(contains(seen, "maxHomeRows=8, home needed 10"));
}

TEST_CASE("R sends refresh")
{
    App app = live();
    app.onRelay(relay(kHome));
    const Frame upper(only(app.onKey(ch('R'))));
    CHECK(upper.str("type") == "refresh");
    const Frame lower(only(app.onKey(ch('r'))));
    CHECK(lower.str("type") == "refresh");
    CHECK(lower.str("id") != upper.str("id"));
}

TEST_CASE("T on approval sends respond with text")
{
    App app = onApproval();
    CHECK(app.onKey(ch('T')).send.empty());
    type(app, "use staging");
    CHECK(row(app, 9).rfind("> use staging_", 0) == 0);
    const Frame respond(only(app.onKey(named(KeyName::Enter))));
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
    const Frame respond(only(app.onKey(named(KeyName::Enter))));
    CHECK(respond.str("value") == "text");
    CHECK(respond.str("text") == "flaky clock");
}

TEST_CASE("a refused respond goes back to the request and says why")
{
    App app = onApproval();
    const Frame sent(only(app.onKey(ch('N'))));
    CHECK(app.screenName() == "thread");
    app.onRelay(t3::Ack{sent.str("id"), false, std::string("request no longer pending")});
    CHECK(app.screenName() == "approval");
    CHECK(row(app, 0).rfind("refused: request no longer pending", 0) == 0);
}

TEST_CASE("thread pages with up and down, backspace on an empty line goes home")
{
    App app = onWeaverThread();
    CHECK(app.onKey(named(KeyName::Up)).send.empty());
    const Frame page(only(app.onKey(named(KeyName::Down))));
    CHECK(page.str("type") == "page");
    CHECK(page.str("threadId") == "thr_weaver");
    CHECK(page.num("page") == 2);
    type(app, "ab");
    app.onKey(named(KeyName::Backspace));
    app.onKey(named(KeyName::Backspace));
    CHECK(app.screenName() == "thread");
    app.onKey(named(KeyName::Backspace));
    CHECK(app.screenName() == "home");
}

TEST_CASE("a truncated reply names its budget")
{
    App app = live();
    app.onRelay(relay(kWeaverHome));
    app.onKey(named(KeyName::Enter));
    app.onRelay(relay(R"({"type":"thread_page","threadId":"thr_weaver","header":{"project":"weaver","title":"layout engine","model":"Opus 5.5","status":"done"},"page":32,"pages":32,"lines":["...end of what fits..."],"truncated":{"budget":"max_reply_pages","limit":32,"actual":57}})"));
    CHECK(contains(row(app, 1), "max_reply_pages=32, reply needed 57"));
}

TEST_CASE("new task cycles workspace and mode with tab and launches with them")
{
    App app = live();
    app.onRelay(relay(kHome));
    app.onKey(ch('n'));
    app.onRelay(relay(R"({"type":"projects","items":[
 {"projectId":"proj_resend","name":"resend-api","defaults":{"model":"Opus 5.5","workspace":"worktree","runtimeMode":"auto"}}],
 "truncated":{"budget":"maxHomeRows","limit":1,"actual":40,"hidden":39}})"));
    std::string shown;
    for (const std::string &r : rows(app)) {
        shown += r.substr(0, r.find_last_not_of(' ') + 1) + " ";
    }
    CHECK(contains(shown, "+39 more projects: maxHomeRows=1, needed 40"));

    app.onKey(named(KeyName::Enter));
    app.onKey(named(KeyName::Tab));
    CHECK(contains(row(app, 2), "[new worktree]"));
    app.onKey(named(KeyName::Right));
    CHECK(contains(row(app, 2), "[root]"));
    app.onKey(named(KeyName::Tab));
    CHECK(contains(row(app, 2), "[auto]"));
    app.onKey(named(KeyName::Right));
    CHECK(contains(row(app, 2), "[full-access]"));

    CHECK(app.onKey(named(KeyName::Enter)).send.empty());
    CHECK(contains(row(app, 0), "prompt"));
    type(app, "go");
    const Frame launch(only(app.onKey(named(KeyName::Enter))));
    CHECK(launch.str("type") == "launch");
    CHECK(launch.str("projectId") == "proj_resend");
    CHECK(launch.str("text") == "go");
    CHECK(launch.str("workspace") == "root");
    CHECK(launch.str("runtimeMode") == "full-access");
    CHECK_FALSE(launch.has("model"));

    app.onRelay(t3::Ack{launch.str("id"), true, std::nullopt});
    CHECK(app.screenName() == "home");
    CHECK(row(app, 0).rfind("task launched", 0) == 0);
}

TEST_CASE("every parse failure reaches the status bar")
{
    App app = live();
    app.onFrame(kHome);
    CHECK(app.screenName() == "home");
    app.onFrame("{not json");
    CHECK(row(app, 0).rfind("frame: not valid json", 0) == 0);
    CHECK(app.screenName() == "home");
}

TEST_CASE("an unknown home kind draws a ? row instead of blanking home")
{
    App app = live();
    app.onRelay(relay(R"({"type":"home","rows":[{"threadId":"thr_x","kind":"paused","project":"api","title":"later","age":"1m"}],
 "counts":{"needs":1,"running":0,"done":0},"approvals":{"available":true},"warnings":[],"t3":"ok"})"));
    CHECK(contains(allText(app), "? api later"));
}

TEST_CASE("an encoder out of memory sends nothing, says so, and keeps the screen usable")
{
    App app = live();
    app.onRelay(relay(kHome));
    {
        FailingAllocator failing;
        CHECK(app.onKey(ch('R')).send.empty());
    }
    CHECK(contains(row(app, 0), "refresh"));
    CHECK(contains(row(app, 0), "memory"));
    CHECK(app.screenName() == "home");
    CHECK(Frame(only(app.onKey(ch('R')))).str("type") == "refresh");
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
    app.onRelay(relay(kHome));
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
    app.onRelay(relay(home));
    CHECK(contains(row(app, 0), "approvals down"));
    CHECK(contains(allText(app), "approvals down: adapter broken"));
    app.onKey(named(KeyName::Enter));
    app.onRelay(relay(kBouncePage));
    app.onRelay(relay(kBounceRequest));
    CHECK(app.onKey(ch('Y')).send.empty());
    CHECK(contains(row(app, 0), "approvals down: adapter broken"));
}

TEST_CASE("warnings, T3 state and error frames show as given")
{
    std::string home = kHome;
    home.replace(home.find(R"("warnings":[])"), 13, R"("warnings":["T3 token expires in 3 days, run t3-cardputer-relay login on the relay host"])");
    home.replace(home.find(R"("t3":"ok")"), 9, R"("t3":"unreachable")");
    App app = live();
    app.onRelay(relay(home));
    CHECK(contains(row(app, 0), "T3 unreachable"));
    std::string body;
    for (const std::string &r : rows(app)) {
        body += r.substr(0, r.find_last_not_of(' ') + 1) + " ";
    }
    CHECK(contains(body, "T3 token expires in 3 days, run t3-cardputer-relay login on the relay host"));

    const std::string message = "max_frame_bytes=4096, request for thr_bounce needed 5120 bytes, the relay sent this error instead";
    app.onRelay(t3::Error{t3::ErrorCode::Internal, message});
    const std::vector<std::string> wrapped = t3::wrapWords(message, t3::Grid::Cols);
    REQUIRE(wrapped.size() == 3);
    for (size_t i = 0; i < wrapped.size(); ++i) {
        CHECK(row(app, static_cast<int>(i)).rfind(wrapped[i], 0) == 0);
    }
}

TEST_CASE("a refused request says why on row 0")
{
    App app = live();
    app.onRelay(relay(kHome));
    const Frame refresh(only(app.onKey(ch('R'))));
    app.onRelay(t3::Ack{refresh.str("id"), false, std::string("T3 unreachable")});
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
    app.onKey(ch('T'));
    type(app, "abc");
    app.onRelay(relay(kBounceRequest));
    CHECK(row(app, 9).rfind("> abc_", 0) == 0);
}
