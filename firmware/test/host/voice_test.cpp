#include "doctest.h"

#include <cstdint>
#include <fstream>
#include <string>
#include <vector>

#include "cJSON.h"
#include "t3/app.h"
#include "t3/power.h"

namespace {

using t3::App;
using t3::Key;
using t3::KeyName;
using Audio = t3::App::Out::Audio;

const t3::HelloCaps kCaps{40, 8, 65536, 64};

const char *kHome = R"({"type":"home","rows":[{"threadId":"thr_weaver","kind":"done","project":"weaver","title":"layout engine","age":"2m"}],
 "counts":{"needs":0,"running":0,"done":1},"approvals":{"available":true},"warnings":[],"t3":"ok"})";

const char *kPage = R"({"type":"thread_page","threadId":"thr_weaver","header":{"project":"weaver","title":"layout engine","model":"Opus 5.5","status":"done"},
 "page":1,"pages":1,"lines":["PR #41 is open against main."]})";

const char *kProjects = R"({"type":"projects","items":[
 {"projectId":"proj_weaver","name":"weaver","defaults":{"model":"Opus 5.5","workspace":"root","runtimeMode":"approval-required"}}]})";

uint32_t now = 0;

uint32_t tick(uint32_t ms = 100)
{
    now += ms;
    return now;
}

App::Out press(App &app, KeyName name)
{
    return app.onKey(Key{name}, tick());
}

App::Out pressChar(App &app, char c)
{
    return app.onKey(Key{KeyName::Char, c}, tick());
}

App::Out pushFrame(App &app, const std::string &json)
{
    return app.onFrame(json, tick());
}

struct Frame {
    explicit Frame(const std::string &text) : json(cJSON_Parse(text.c_str())) { REQUIRE(json != nullptr); }
    ~Frame() { cJSON_Delete(json); }
    Frame(const Frame &) = delete;
    Frame &operator=(const Frame &) = delete;

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

std::string type(const std::string &frame)
{
    return Frame(frame).str("type");
}

bool sendsAudioFrame(const App::Out &out)
{
    for (const std::string &frame : out.send) {
        if (type(frame).rfind("audio_", 0) == 0) {
            return true;
        }
    }
    return false;
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

std::string allText(const App &app)
{
    std::string text;
    for (const std::string &r : rows(app)) {
        text += r + "\n";
    }
    return text;
}

bool shows(const App &app, const std::string &needle)
{
    return allText(app).find(needle) != std::string::npos;
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

App onThread()
{
    App app(kCaps, 11);
    app.onLinkStatus("");
    pushFrame(app, kHome);
    const App::Out open = press(app, KeyName::Enter);
    CHECK(type(only(open)) == "open_thread");
    pushFrame(app, kPage);
    REQUIRE(app.screenName() == "thread");
    return app;
}

std::string transcript(const std::string &text)
{
    return R"({"type":"transcript_final","text":")" + text + R"("})";
}

std::string ack(const std::string &id, bool ok, const std::string &error = "")
{
    return R"({"type":"ack","id":")" + id + R"(","ok":)" + (ok ? "true" : "false") + (error.empty() ? "" : R"(,"error":")" + error + "\"") + "}";
}

struct Recorded {
    std::string startId;
    std::string endId;
};

Recorded record(App &app)
{
    const App::Out down = press(app, KeyName::TalkDown);
    const Frame start(only(down));
    const App::Out up = press(app, KeyName::TalkUp);
    const Frame end(only(up));
    return {start.str("id"), end.str("id")};
}

}

TEST_CASE("talk-down sends audio_start and starts audio")
{
    App app = onThread();
    const App::Out out = press(app, KeyName::TalkDown);
    const Frame start(only(out));
    CHECK(start.str("type") == "audio_start");
    CHECK(start.num("sampleRate") == 16000);
    CHECK_FALSE(start.str("id").empty());
    CHECK(out.audio == Audio::Start);
    CHECK(app.screenName() == "voice");
    CHECK(app.recording());
    CHECK(shows(app, "REC 0:00"));
}

TEST_CASE("talk-up sends audio_end")
{
    App app = onThread();
    const Frame start(only(press(app, KeyName::TalkDown)));
    const App::Out out = press(app, KeyName::TalkUp);
    const Frame end(only(out));
    CHECK(end.str("type") == "audio_end");
    CHECK(end.str("id") != start.str("id"));
    CHECK(out.audio == Audio::Stop);
    CHECK_FALSE(app.recording());
    CHECK(app.screenName() == "voice");
    CHECK(rows(app)[10].rfind("transcribing...", 0) == 0);
}

TEST_CASE("link loss while recording cancels, shows voice: connection lost, sends nothing on reconnect")
{
    App app = onThread();
    press(app, KeyName::TalkDown);
    REQUIRE(app.recording());

    const App::Out lost = app.onLinkStatus("reconnecting in 1s");
    CHECK(lost.audio == Audio::Cancel);
    CHECK(lost.send.empty());
    CHECK_FALSE(app.recording());
    CHECK(rows(app)[0].rfind("voice: connection lost", 0) == 0);

    const App::Out up = press(app, KeyName::TalkUp);
    CHECK(up.send.empty());
    CHECK(up.audio == Audio::None);
    CHECK(rows(app)[0].rfind("voice: connection lost", 0) == 0);

    const App::Out back = app.onLinkStatus("");
    CHECK_FALSE(sendsAudioFrame(back));
    CHECK(back.audio == Audio::None);
    CHECK(app.screenName() == "thread");

    const App::Out again = press(app, KeyName::TalkDown);
    CHECK(type(only(again)) == "audio_start");
    CHECK(again.audio == Audio::Start);
}

TEST_CASE("transcript_final shows text and enter sends reply")
{
    App app = onThread();
    record(app);
    CHECK(pushFrame(app, transcript("ship it, but also add a test")).send.empty());
    CHECK(app.screenName() == "voice");
    CHECK(shows(app, "ship it, but also add a test"));
    CHECK(shows(app, "Enter send  E edit  Bksp discard  ` more"));

    const App::Out out = press(app, KeyName::Enter);
    const Frame reply(only(out));
    CHECK(reply.str("type") == "reply");
    CHECK(reply.str("threadId") == "thr_weaver");
    CHECK(reply.str("text") == "ship it, but also add a test");
    CHECK(reply.str("mode") == "queue");
    CHECK(app.screenName() == "thread");
}

TEST_CASE("fn+enter on a transcript sends it as steer")
{
    App app = onThread();
    record(app);
    pushFrame(app, transcript("stop and rerun"));
    const Frame reply(only(press(app, KeyName::FnEnter)));
    CHECK(reply.str("mode") == "steer");
}

TEST_CASE("E puts the transcript in the reply line after what was typed")
{
    App app = onThread();
    pressChar(app, 'o');
    pressChar(app, 'k');
    record(app);
    pushFrame(app, transcript("ship it"));
    CHECK(pressChar(app, 'E').send.empty());
    CHECK(app.screenName() == "thread");
    CHECK(shows(app, "> ok ship it_"));
    CHECK(app.editing());
}

TEST_CASE("backspace discards the transcript and keeps the typed line")
{
    App app = onThread();
    pressChar(app, 'o');
    record(app);
    pushFrame(app, transcript("ship it"));
    CHECK(press(app, KeyName::Backspace).send.empty());
    CHECK(app.screenName() == "thread");
    CHECK(shows(app, "> o_"));
    CHECK_FALSE(shows(app, "ship it"));
}

TEST_CASE("holding talk again on a transcript records more and appends")
{
    App app = onThread();
    record(app);
    pushFrame(app, transcript("ship it,"));
    record(app);
    pushFrame(app, transcript("but add a test"));
    CHECK(shows(app, "ship it, but add a test"));
    const Frame reply(only(press(app, KeyName::Enter)));
    CHECK(reply.str("text") == "ship it, but add a test");
}

TEST_CASE("voice matches mockup 4")
{
    App app = onThread();
    record(app);
    pushFrame(app, transcript("ship it, but also add a test for the 2049th node case"));
    press(app, KeyName::TalkDown);
    const int levels[] = {-90, -50, -35, -10, -10, -35, -50, -90, -50, -35, -10, -35, -50, -90, -90, -50, -35, -10, -35, -50, -90, -90, -90};
    for (int dbfs : levels) {
        app.onAudio(dbfs, tick());
    }
    app.onAudio(-90, tick(6000 - 2300));
    checkGolden(app, "voice");
}

TEST_CASE("the REC timer counts from talk-down")
{
    App app = onThread();
    press(app, KeyName::TalkDown);
    app.onAudio(-60, tick(65000));
    CHECK(shows(app, "REC 1:05"));
}

TEST_CASE("a talk-up with no recording sends nothing")
{
    App app = onThread();
    const App::Out out = press(app, KeyName::TalkUp);
    CHECK(out.send.empty());
    CHECK(out.audio == Audio::None);
    CHECK(app.screenName() == "thread");
}

TEST_CASE("talk-down with the link down says so and sends nothing")
{
    App app = onThread();
    app.onLinkStatus("reconnecting in 1s");
    const App::Out out = press(app, KeyName::TalkDown);
    CHECK(out.send.empty());
    CHECK(out.audio == Audio::None);
    CHECK(app.screenName() == "thread");
    CHECK(rows(app)[0].rfind("voice: not connected", 0) == 0);
}

TEST_CASE("talk-down on home does nothing")
{
    App app(kCaps, 11);
    app.onLinkStatus("");
    pushFrame(app, kHome);
    const App::Out out = press(app, KeyName::TalkDown);
    CHECK(out.send.empty());
    CHECK(out.audio == Audio::None);
    CHECK(app.screenName() == "home");
}

TEST_CASE("a refused audio_start cancels the recording and says why")
{
    App app = onThread();
    const Frame start(only(press(app, KeyName::TalkDown)));
    const App::Out out = pushFrame(app, ack(start.str("id"), false, "audio already started"));
    CHECK(out.audio == Audio::Cancel);
    CHECK(type(only(out)) == "audio_cancel");
    CHECK_FALSE(app.recording());
    CHECK(app.screenName() == "thread");
    CHECK(rows(app)[0].rfind("voice: refused: audio already started", 0) == 0);
}

TEST_CASE("a refused audio_end says why and the next hold works")
{
    App app = onThread();
    const Recorded rec = record(app);
    const App::Out out = pushFrame(app, ack(rec.endId, false, "no audio received"));
    CHECK(out.send.empty());
    CHECK(app.screenName() == "thread");
    CHECK(rows(app)[0].rfind("voice: no audio received", 0) == 0);
    CHECK(type(only(press(app, KeyName::TalkDown))) == "audio_start");
}

TEST_CASE("an audio budget error while recording stops the mic and closes the window")
{
    App app = onThread();
    press(app, KeyName::TalkDown);
    const App::Out out = pushFrame(app, R"({"type":"error","code":"bad_audio","message":"audio budget: audio_max_seconds=120, recording reached 120s"})");
    CHECK(out.audio == Audio::Cancel);
    CHECK(type(only(out)) == "audio_cancel");
    CHECK_FALSE(app.recording());
    CHECK(rows(app)[0].rfind("voice: audio budget:", 0) == 0);
    CHECK(shows(app, "audio_max_seconds=120"));
}

TEST_CASE("a failed transcription says so and frees the next hold")
{
    App app = onThread();
    record(app);
    pushFrame(app, R"({"type":"error","code":"internal","message":"transcription failed"})");
    CHECK(app.screenName() == "thread");
    CHECK(rows(app)[0].rfind("voice: transcription failed", 0) == 0);
    CHECK(type(only(press(app, KeyName::TalkDown))) == "audio_start");
}

TEST_CASE("an empty transcript says nothing was heard")
{
    App app = onThread();
    record(app);
    pushFrame(app, transcript(""));
    CHECK(app.screenName() == "voice");
    CHECK(rows(app)[0].rfind("voice: nothing heard", 0) == 0);
    CHECK(press(app, KeyName::Enter).send.empty());
}

TEST_CASE("a lost audio send ends the recording and closes the window")
{
    App app = onThread();
    press(app, KeyName::TalkDown);
    const App::Out out = app.onAudioFailed("send failed, 3200 bytes not sent");
    CHECK(out.audio == Audio::Cancel);
    CHECK(type(only(out)) == "audio_cancel");
    CHECK_FALSE(app.recording());
    CHECK(rows(app)[0].rfind("voice: send failed, 3200 bytes not sent", 0) == 0);
}

TEST_CASE("link loss while transcribing says the transcript is lost")
{
    App app = onThread();
    record(app);
    const App::Out out = app.onLinkStatus("reconnecting in 1s");
    CHECK(out.audio == Audio::None);
    CHECK(app.screenName() == "thread");
    CHECK(rows(app)[0].rfind("voice: connection lost, transcript lost", 0) == 0);
    app.onLinkStatus("");
    CHECK(type(only(press(app, KeyName::TalkDown))) == "audio_start");
}

TEST_CASE("a transcript still owed blocks the next hold, even after discarding it")
{
    App app = onThread();
    record(app);
    CHECK(press(app, KeyName::Backspace).send.empty());
    CHECK(app.screenName() == "thread");
    const App::Out blocked = press(app, KeyName::TalkDown);
    CHECK(blocked.send.empty());
    CHECK(blocked.audio == Audio::None);
    CHECK(rows(app)[0].rfind("voice: still transcribing", 0) == 0);

    pushFrame(app, transcript("late words"));
    CHECK(app.screenName() == "thread");
    CHECK_FALSE(shows(app, "late words"));
    CHECK(type(only(press(app, KeyName::TalkDown))) == "audio_start");
}

TEST_CASE("backspace while recording cancels it")
{
    App app = onThread();
    press(app, KeyName::TalkDown);
    const App::Out out = press(app, KeyName::Backspace);
    CHECK(out.audio == Audio::Cancel);
    CHECK(type(only(out)) == "audio_cancel");
    CHECK(app.screenName() == "thread");
    CHECK(press(app, KeyName::TalkUp).send.empty());
}

TEST_CASE("voice from new task fills the prompt and enter launches it")
{
    App app(kCaps, 11);
    app.onLinkStatus("");
    pushFrame(app, kHome);
    pressChar(app, 'N');
    pushFrame(app, kProjects);
    press(app, KeyName::Enter);
    REQUIRE(app.screenName() == "new_task");
    record(app);
    pushFrame(app, transcript("find why the bounce webhook drops events"));
    CHECK(rows(app)[0].rfind("weaver - new task", 0) == 0);
    const Frame launch(only(press(app, KeyName::Enter)));
    CHECK(launch.str("type") == "launch");
    CHECK(launch.str("text") == "find why the bounce webhook drops events");
    CHECK(app.screenName() == "new_task");
}

TEST_CASE("recording and transcribing count as editing so the screen never goes dark mid-prompt")
{
    App app = onThread();
    press(app, KeyName::TalkDown);
    CHECK(app.editing());
    press(app, KeyName::TalkUp);
    CHECK(app.editing());
}

TEST_CASE("chunkDbfs is the rms level in dB below full scale")
{
    const std::vector<int16_t> silence(1600, 0);
    CHECK(t3::chunkDbfs(silence.data(), silence.size()) == t3::kSilenceDbfs);
    std::vector<int16_t> full(1600);
    for (size_t i = 0; i < full.size(); ++i) {
        full[i] = i % 2 == 0 ? 32767 : -32768;
    }
    CHECK(t3::chunkDbfs(full.data(), full.size()) == 0);
    std::vector<int16_t> tenth(1600);
    for (size_t i = 0; i < tenth.size(); ++i) {
        tenth[i] = i % 2 == 0 ? 3277 : -3277;
    }
    CHECK(t3::chunkDbfs(tenth.data(), tenth.size()) == -20);
    CHECK(t3::chunkDbfs(nullptr, 0) == t3::kSilenceDbfs);
}

TEST_CASE("a recording keeps the screen full past the dim and off timeouts")
{
    t3::Power p(1000, 3000, 0);
    p.setRecording(true);
    CHECK_FALSE(p.onTick(5000));
    CHECK(p.level() == t3::Power::Level::Full);
    p.setRecording(false);
    CHECK_FALSE(p.onTick(5999));
    CHECK(p.onTick(6000));
    CHECK(p.level() == t3::Power::Level::Dim);
}

TEST_CASE("talk-up is delivered even when it wakes the screen, other keys only wake it")
{
    t3::Power p(1000, 3000, 0);
    p.onTick(3000);
    REQUIRE(p.level() == t3::Power::Level::Off);
    CHECK(p.onKey(KeyName::TalkUp, 3001) == t3::Power::KeyEffect::WokeAndDeliver);
    CHECK(p.level() == t3::Power::Level::Full);
    p.onTick(7000);
    REQUIRE(p.level() == t3::Power::Level::Off);
    CHECK(p.onKey(KeyName::TalkDown, 7001) == t3::Power::KeyEffect::Woke);
}

TEST_CASE("a talk-down swallowed by the wake never produces audio_end or audio_cancel")
{
    t3::Power p(1000, 3000, 0);
    App app = onThread();
    p.onTick(3000);
    REQUIRE(p.onKey(KeyName::TalkDown, 3001) == t3::Power::KeyEffect::Woke);
    REQUIRE(p.onKey(KeyName::TalkUp, 3002) == t3::Power::KeyEffect::Deliver);
    const App::Out out = press(app, KeyName::TalkUp);
    CHECK(out.send.empty());
    CHECK(out.audio == Audio::None);
}

TEST_CASE("a rejected token while recording stops the mic before the pair screen")
{
    App app = onThread();
    press(app, KeyName::TalkDown);
    const App::Out out = app.onAuthRejected();
    CHECK(out.audio == Audio::Cancel);
    CHECK(out.send.empty());
    CHECK_FALSE(app.recording());
    CHECK(app.screenName() == "setup_pair");
}

TEST_CASE("a request pushed for the thread while recording waits for Tab")
{
    App app = onThread();
    press(app, KeyName::TalkDown);
    const std::string request = R"({"type":"request","threadId":"thr_weaver","requestId":"req_9","kind":"approval",
 "lines":["Wants to run a command:","  ls"],"options":[{"key":"Y","label":"Allow once","value":"allow_once"}]})";
    CHECK(pushFrame(app, request).audio == Audio::None);
    CHECK(app.recording());
    CHECK(app.screenName() == "voice");
    press(app, KeyName::Backspace);
    REQUIRE(app.screenName() == "thread");
    CHECK(press(app, KeyName::Tab).send.empty());
    CHECK(app.screenName() == "approval");
}
