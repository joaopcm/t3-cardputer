#include "doctest.h"

#include <fstream>
#include <string>
#include <vector>

#include "t3/app.h"

namespace {

using t3::App;
using t3::Key;
using t3::KeyName;
using t3::WifiNet;

const t3::HelloCaps kCaps{40, 8, 65536, 64};

const char *kHome = R"({"type":"home","rows":[{"threadId":"thr_weaver","kind":"done","project":"weaver","title":"layout engine","age":"2m"}],
 "counts":{"needs":0,"running":0,"done":1},"approvals":{"available":true},"warnings":[],"t3":"ok"})";

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
        press(app, ch(c));
    }
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
    for (const std::string &row : rows(app)) {
        text += row + "\n";
    }
    return text;
}

bool contains(const std::string &haystack, const std::string &needle)
{
    return haystack.find(needle) != std::string::npos;
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

const std::vector<WifiNet> kNets = {
    {"corner-cafe", -48, true, false},
    {"home-5g", -61, true, true},
    {"guest", -70, false, false},
};

App live()
{
    App app(kCaps, 7);
    app.onBoot(true, true);
    app.onLinkStatus("");
    app.onFrame(kHome, tick());
    return app;
}

App onList()
{
    App app(kCaps, 7);
    app.onBoot(false, false);
    app.onWifiScan(kNets);
    return app;
}

App onPassword()
{
    App app = onList();
    press(app, named(KeyName::Enter));
    return app;
}

App onPair()
{
    App app(kCaps, 7);
    app.onBoot(true, false);
    return app;
}

}

TEST_CASE("no token opens pairing")
{
    App app(kCaps, 7);
    const App::Out out = app.onBoot(true, false);
    CHECK(app.screenName() == "setup_pair");
    CHECK_FALSE(out.scanWifi);
    CHECK(contains(allText(app), "t3-cardputer-relay pair"));
}

TEST_CASE("no wifi opens the network list and asks for a scan")
{
    App app(kCaps, 7);
    const App::Out out = app.onBoot(false, true);
    CHECK(app.screenName() == "setup_wifi");
    CHECK(out.scanWifi);
    CHECK(contains(allText(app), "scanning"));
}

TEST_CASE("saved wifi and a saved token leave setup closed")
{
    App app(kCaps, 7);
    const App::Out out = app.onBoot(true, true);
    CHECK(app.screenName() == "connecting");
    CHECK_FALSE(out.scanWifi);
}

TEST_CASE("4401 opens pairing with the re-pair message")
{
    App app = live();
    CHECK(app.screenName() == "home");
    app.onAuthRejected();
    CHECK(app.screenName() == "setup_pair");
    CHECK(contains(allText(app), "re-pair needed"));
    CHECK(contains(allText(app), "t3-cardputer-relay pair"));
}

TEST_CASE("fn+s opens setup from home")
{
    App app = live();
    const App::Out out = press(app, named(KeyName::FnS));
    CHECK(app.screenName() == "setup_wifi");
    CHECK(out.scanWifi);
}

TEST_CASE("fn+s opens setup while still connecting, so a bad network is fixable")
{
    App app(kCaps, 7);
    app.onBoot(true, true);
    press(app, named(KeyName::FnS));
    CHECK(app.screenName() == "setup_wifi");
}

TEST_CASE("fn+s does nothing inside a thread")
{
    App app = live();
    press(app, named(KeyName::Enter));
    CHECK(app.screenName() == "thread");
    press(app, named(KeyName::FnS));
    CHECK(app.screenName() == "thread");
}

TEST_CASE("the list shows scan results with the saved and open ones tagged and picks with the arrows")
{
    App app = onList();
    const std::string text = allText(app);
    CHECK(contains(text, "corner-cafe"));
    CHECK(contains(text, "-48"));
    CHECK(contains(text, "saved"));
    CHECK(contains(text, "open"));
    CHECK(selectedRow(app) == 2);
    press(app, named(KeyName::Down));
    CHECK(selectedRow(app) == 3);
    press(app, named(KeyName::Down));
    press(app, named(KeyName::Down));
    CHECK(selectedRow(app) == 4);
    press(app, named(KeyName::Up));
    CHECK(selectedRow(app) == 3);
}

TEST_CASE("an empty scan says so and R scans again")
{
    App app(kCaps, 7);
    app.onBoot(false, true);
    app.onWifiScan({});
    CHECK(contains(allText(app), "no networks found"));
    CHECK(press(app, ch('r')).scanWifi);
    CHECK(contains(allText(app), "scanning"));
}

TEST_CASE("a long scan list scrolls to keep the selection visible")
{
    std::vector<WifiNet> many;
    for (int i = 0; i < 20; ++i) {
        many.push_back({"net" + std::to_string(i), -50 - i, true, false});
    }
    App app(kCaps, 7);
    app.onBoot(false, true);
    app.onWifiScan(many);
    for (int i = 0; i < 19; ++i) {
        press(app, named(KeyName::Down));
    }
    CHECK(contains(allText(app), "net19"));
    CHECK_FALSE(contains(allText(app), "net0 "));
    CHECK(selectedRow(app) == 9);
}

TEST_CASE("enter on a network opens its password screen with the name on top")
{
    App app = onList();
    press(app, named(KeyName::Down));
    press(app, named(KeyName::Enter));
    CHECK(app.screenName() == "setup_password");
    CHECK(rows(app)[1].rfind("home-5g", 0) == 0);
}

TEST_CASE("password field masks input")
{
    App app = onPassword();
    type(app, "hunter22");
    const std::string text = allText(app);
    CHECK_FALSE(contains(text, "hunter"));
    CHECK(contains(text, "> ********_"));
    press(app, named(KeyName::Backspace));
    CHECK(contains(allText(app), "> *******_"));
}

TEST_CASE("the password field shows only its tail when long and still masks it")
{
    App app = onPassword();
    type(app, std::string(50, 'a'));
    const std::string text = allText(app);
    CHECK_FALSE(contains(text, "aaa"));
    CHECK(contains(text, "50 chars"));
}

TEST_CASE("the password stops at the wifi limit and names it")
{
    App app = onPassword();
    type(app, std::string(64, 'a'));
    CHECK(rows(app)[0].rfind("wifi_password_max=63, password needed 64", 0) == 0);
    CHECK(contains(allText(app), "63 chars"));
}

TEST_CASE("a password under 8 characters is refused with the numbers")
{
    App app = onPassword();
    type(app, "abc");
    const App::Out out = press(app, named(KeyName::Enter));
    CHECK_FALSE(out.joinWifi.has_value());
    CHECK(rows(app)[0].rfind("wifi_password_min=8, password has 3", 0) == 0);
}

TEST_CASE("enter joins once with the typed password, a second enter waits")
{
    App app = onPassword();
    type(app, "hunter22");
    const App::Out out = press(app, named(KeyName::Enter));
    REQUIRE(out.joinWifi.has_value());
    CHECK(out.joinWifi->ssid == "corner-cafe");
    CHECK(out.joinWifi->password == "hunter22");
    CHECK(contains(allText(app), "joining"));
    CHECK_FALSE(press(app, named(KeyName::Enter)).joinWifi.has_value());
}

TEST_CASE("an open network joins with no password")
{
    App app = onList();
    press(app, named(KeyName::Down));
    press(app, named(KeyName::Down));
    press(app, named(KeyName::Enter));
    CHECK(contains(allText(app), "open network"));
    const App::Out out = press(app, named(KeyName::Enter));
    REQUIRE(out.joinWifi.has_value());
    CHECK(out.joinWifi->ssid == "guest");
    CHECK(out.joinWifi->password.empty());
}

TEST_CASE("a backtick typed into the password is a character, not the talk key")
{
    App app = onPassword();
    type(app, "pass");
    press(app, named(KeyName::TalkDown));
    press(app, named(KeyName::TalkUp));
    type(app, "wd1");
    CHECK(contains(allText(app), "> ********_"));
    const App::Out out = press(app, named(KeyName::Enter));
    REQUIRE(out.joinWifi.has_value());
    CHECK(out.joinWifi->password == "pass`wd1");
}

TEST_CASE("a failed join says why and keeps the password screen")
{
    App app = onPassword();
    type(app, "hunter22");
    press(app, named(KeyName::Enter));
    app.onWifiResult(false, "wrong password");
    CHECK(app.screenName() == "setup_password");
    CHECK(rows(app)[0].rfind("wrong password", 0) == 0);
    CHECK(press(app, named(KeyName::Enter)).joinWifi.has_value());
}

TEST_CASE("a joined network moves on to pairing when there is no token")
{
    App app = onPassword();
    type(app, "hunter22");
    press(app, named(KeyName::Enter));
    app.onWifiResult(true, "");
    CHECK(app.screenName() == "setup_pair");
}

TEST_CASE("a joined network closes setup when the token is already saved")
{
    App app = live();
    press(app, named(KeyName::FnS));
    app.onWifiScan(kNets);
    press(app, named(KeyName::Enter));
    type(app, "hunter22");
    press(app, named(KeyName::Enter));
    app.onWifiResult(true, "");
    CHECK(app.screenName() == "home");
}

TEST_CASE("a join result nobody asked for changes nothing")
{
    App app = onList();
    app.onWifiResult(true, "");
    CHECK(app.screenName() == "setup_wifi");
}

TEST_CASE("D forgets the saved network under the cursor and only that one")
{
    App app = onList();
    CHECK_FALSE(press(app, ch('d')).forgetWifi.has_value());
    press(app, named(KeyName::Down));
    const App::Out out = press(app, ch('d'));
    REQUIRE(out.forgetWifi.has_value());
    CHECK(*out.forgetWifi == "home-5g");
    CHECK_FALSE(contains(allText(app), "saved"));
}

TEST_CASE("escape climbs one level at a time and leaves setup from the list")
{
    App app = live();
    press(app, named(KeyName::FnS));
    app.onWifiScan(kNets);
    press(app, named(KeyName::Enter));
    CHECK(app.screenName() == "setup_password");
    press(app, named(KeyName::Esc));
    CHECK(app.screenName() == "setup_wifi");
    press(app, named(KeyName::Tab));
    CHECK(app.screenName() == "setup_pair");
    press(app, named(KeyName::Esc));
    CHECK(app.screenName() == "setup_wifi");
    press(app, named(KeyName::Esc));
    CHECK(app.screenName() == "home");
}

TEST_CASE("backspace on an empty password goes back to the list")
{
    App app = onPassword();
    press(app, named(KeyName::Backspace));
    CHECK(app.screenName() == "setup_wifi");
}

TEST_CASE("pairing uppercases the code, takes letters and digits, and stops at 8")
{
    App app = onPair();
    type(app, "7kq2m9xa");
    CHECK(contains(allText(app), "> 7KQ2M9XA_"));
    type(app, "z");
    CHECK(rows(app)[0].rfind("pair_code_len=8, code needed 9", 0) == 0);
    press(app, named(KeyName::Backspace));
    press(app, ch('-'));
    CHECK(rows(app)[0].rfind("code is letters and digits only", 0) == 0);
    CHECK(contains(allText(app), "> 7KQ2M9X_"));
}

TEST_CASE("a short code is refused with the numbers")
{
    App app = onPair();
    type(app, "7KQ2");
    const App::Out out = press(app, named(KeyName::Enter));
    CHECK_FALSE(out.pair.has_value());
    CHECK(rows(app)[0].rfind("pair_code_len=8, code has 4", 0) == 0);
}

TEST_CASE("a full code emits one pair request named cardputer")
{
    App app = onPair();
    type(app, "7KQ2M9XA");
    const App::Out out = press(app, named(KeyName::Enter));
    REQUIRE(out.pair.has_value());
    CHECK(out.pair->code == "7KQ2M9XA");
    CHECK(out.pair->name == "cardputer");
    CHECK(contains(allText(app), "pairing"));
    CHECK_FALSE(press(app, named(KeyName::Enter)).pair.has_value());
}

TEST_CASE("a paired token is handed out to store, setup closes and the link reconnects")
{
    App app = onPair();
    type(app, "7KQ2M9XA");
    press(app, named(KeyName::Enter));
    const App::Out out = app.onPairResult("tok_abc", "");
    REQUIRE(out.storeToken.has_value());
    CHECK(*out.storeToken == "tok_abc");
    CHECK(out.reconnect);
    CHECK(app.screenName() == "connecting");
    CHECK(contains(allText(app), "paired"));
}

TEST_CASE("a failed pairing says why, keeps the code and lets the user retry")
{
    App app = onPair();
    type(app, "7KQ2M9XA");
    press(app, named(KeyName::Enter));
    const App::Out out = app.onPairResult(std::nullopt, "pairing failed");
    CHECK_FALSE(out.storeToken.has_value());
    CHECK(app.screenName() == "setup_pair");
    CHECK(rows(app)[0].rfind("pairing failed", 0) == 0);
    CHECK(contains(allText(app), "> 7KQ2M9XA_"));
    CHECK(press(app, named(KeyName::Enter)).pair.has_value());
}

TEST_CASE("a pair result nobody asked for is ignored")
{
    App app = onPair();
    const App::Out out = app.onPairResult("tok_abc", "");
    CHECK_FALSE(out.storeToken.has_value());
    CHECK(app.screenName() == "setup_pair");
}

TEST_CASE("pairing a device that has no wifi yet goes back to wifi on escape")
{
    App app(kCaps, 7);
    app.onBoot(false, false);
    app.onWifiScan(kNets);
    press(app, named(KeyName::Tab));
    CHECK(app.screenName() == "setup_pair");
}

TEST_CASE("a request pushed during setup is a notice, not a screen change")
{
    App app = live();
    press(app, named(KeyName::FnS));
    app.onFrame(R"({"type":"request","threadId":"thr_x","requestId":"req_1","kind":"approval","lines":["Wants to run a command"],"options":[]})", tick());
    CHECK(app.screenName() == "setup_wifi");
    CHECK(rows(app)[0].rfind("request waiting", 0) == 0);
}

TEST_CASE("a link status never hides the setup bar")
{
    App app(kCaps, 7);
    app.onBoot(false, false);
    app.onLinkStatus("starting");
    CHECK(rows(app)[0].rfind("setup", 0) == 0);
}

TEST_CASE("wifi list matches the setup look")
{
    App app = onList();
    press(app, named(KeyName::Down));
    checkGolden(app, "setup_wifi");
}

TEST_CASE("password screen matches the setup look")
{
    App app = onPassword();
    type(app, "hunter22");
    checkGolden(app, "setup_password");
}

TEST_CASE("pair screen matches the setup look")
{
    App app = onPair();
    type(app, "7KQ2");
    checkGolden(app, "setup_pair");
}

TEST_CASE("re-pair screen matches the setup look")
{
    App app = live();
    app.onAuthRejected();
    checkGolden(app, "setup_repair");
}
