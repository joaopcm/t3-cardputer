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
    app.onBoot(true, true, true);
    app.onLinkStatus("", tick());
    app.onFrame(kHome, tick());
    return app;
}

App onList()
{
    App app(kCaps, 7);
    app.setRelayUrl("https://relay.example.com:8443");
    app.onBoot(false, false, true);
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
    app.onBoot(true, false, true);
    return app;
}

}

TEST_CASE("no token opens pairing")
{
    App app(kCaps, 7);
    const App::Out out = app.onBoot(true, false, true);
    CHECK(app.screenName() == "setup_pair");
    CHECK_FALSE(out.scanWifi);
    CHECK(contains(allText(app), "t3-cardputer-relay pair"));
}

TEST_CASE("no wifi opens the network list and asks for a scan")
{
    App app(kCaps, 7);
    const App::Out out = app.onBoot(false, true, true);
    CHECK(app.screenName() == "setup_wifi");
    CHECK(out.scanWifi);
    CHECK(contains(allText(app), "scanning"));
}

TEST_CASE("saved wifi and a saved token leave setup closed")
{
    App app(kCaps, 7);
    const App::Out out = app.onBoot(true, true, true);
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
    app.onBoot(true, true, true);
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
    CHECK(selectedRow(app) == 4);
    press(app, named(KeyName::Down));
    press(app, named(KeyName::Down));
    press(app, named(KeyName::Down));
    CHECK(selectedRow(app) == 6);
    press(app, named(KeyName::Up));
    CHECK(selectedRow(app) == 5);
}

TEST_CASE("the list ends with a row to type a hidden network's name, then its password")
{
    App app = onList();
    for (int i = 0; i < 3; ++i) {
        press(app, named(KeyName::Down));
    }
    CHECK(rows(app)[5].rfind("+ type a network name", 0) == 0);
    CHECK(press(app, ch('d')).forgetWifi == std::nullopt);
    press(app, named(KeyName::Enter));
    CHECK(app.screenName() == "setup_ssid");
    CHECK(app.editing());
    type(app, "attic`ap");
    CHECK(contains(allText(app), "> attic`ap_"));
    press(app, named(KeyName::Enter));
    CHECK(app.screenName() == "setup_password");
    CHECK(rows(app)[1].rfind("attic`ap", 0) == 0);
    type(app, "hunter22");
    const App::Out out = press(app, named(KeyName::Enter));
    REQUIRE(out.joinWifi.has_value());
    CHECK(out.joinWifi->ssid == "attic`ap");
    CHECK(out.joinWifi->password == "hunter22");
}

TEST_CASE("a typed network joins open with no password, a short one is still refused")
{
    App app = onList();
    for (int i = 0; i < 3; ++i) {
        press(app, named(KeyName::Down));
    }
    press(app, named(KeyName::Enter));
    type(app, "cafe");
    press(app, named(KeyName::Enter));
    CHECK(contains(allText(app), "empty joins an open network"));
    type(app, "abc");
    CHECK_FALSE(press(app, named(KeyName::Enter)).joinWifi.has_value());
    CHECK(rows(app)[0].rfind("wifi_password_min=8, password has 3", 0) == 0);
    for (int i = 0; i < 3; ++i) {
        press(app, named(KeyName::Backspace));
    }
    const App::Out out = press(app, named(KeyName::Enter));
    REQUIRE(out.joinWifi.has_value());
    CHECK(out.joinWifi->ssid == "cafe");
    CHECK(out.joinWifi->password.empty());
}

TEST_CASE("an empty scan still offers to type a name")
{
    App app(kCaps, 7);
    app.onBoot(false, true, true);
    app.onWifiScan({});
    CHECK(contains(allText(app), "no networks found"));
    CHECK(selectedRow(app) == 3);
    press(app, named(KeyName::Enter));
    CHECK(app.screenName() == "setup_ssid");
}

TEST_CASE("a typed name stops at the ssid limit, an empty one is refused, and backspace on empty goes back")
{
    App app = onList();
    for (int i = 0; i < 3; ++i) {
        press(app, named(KeyName::Down));
    }
    press(app, named(KeyName::Enter));
    press(app, named(KeyName::Enter));
    CHECK(app.screenName() == "setup_ssid");
    CHECK(rows(app)[0].rfind("type a network name first", 0) == 0);
    type(app, std::string(32, 'n'));
    press(app, ch('x'));
    CHECK(rows(app)[0].rfind("wifi_ssid_max=32, ssid needed 33", 0) == 0);
    for (int i = 0; i < 32; ++i) {
        press(app, named(KeyName::Backspace));
    }
    press(app, named(KeyName::Backspace));
    CHECK(app.screenName() == "setup_wifi");
}

TEST_CASE("an empty scan says so and R scans again")
{
    App app(kCaps, 7);
    app.onBoot(false, true, true);
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
    app.onBoot(false, true, true);
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

TEST_CASE("D asks to forget the saved network under the cursor and only that one, the row changes when it is forgotten")
{
    App app = onList();
    CHECK_FALSE(press(app, ch('d')).forgetWifi.has_value());
    press(app, named(KeyName::Down));
    const App::Out out = press(app, ch('d'));
    REQUIRE(out.forgetWifi.has_value());
    CHECK(*out.forgetWifi == "home-5g");
    CHECK(contains(allText(app), "saved"));
    app.onWifiForgotten("home-5g", true, "");
    CHECK_FALSE(contains(allText(app), "saved"));
}

TEST_CASE("a forget that was not written says why and keeps the saved tag")
{
    App app = onList();
    press(app, named(KeyName::Down));
    press(app, ch('d'));
    app.onWifiForgotten("home-5g", false, "nvs: wifi not saved: ESP_ERR_NVS_NOT_ENOUGH_SPACE");
    CHECK(rows(app)[0].rfind("nvs: wifi not saved:", 0) == 0);
    CHECK(contains(allText(app), "ESP_ERR_NVS_NOT_ENOUGH_SPACE"));
    CHECK(contains(allText(app), "saved"));
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

TEST_CASE("a paired token is handed out to store, and only a stored token closes setup and reconnects")
{
    App app = onPair();
    type(app, "7KQ2M9XA");
    press(app, named(KeyName::Enter));
    const App::Out out = app.onPairResult("tok_abc", "");
    REQUIRE(out.storeToken.has_value());
    CHECK(*out.storeToken == "tok_abc");
    CHECK_FALSE(out.reconnect);
    CHECK(app.screenName() == "setup_pair");
    CHECK_FALSE(contains(allText(app), "paired"));
    const App::Out done = app.onTokenStored(true, "");
    CHECK(done.reconnect);
    CHECK(app.screenName() == "connecting");
    CHECK(contains(allText(app), "paired"));
}

TEST_CASE("a token that was not written says why, never says paired and asks for a new code")
{
    App app = onPair();
    type(app, "7KQ2M9XA");
    press(app, named(KeyName::Enter));
    app.onPairResult("tok_abc", "");
    const App::Out out = app.onTokenStored(false, "nvs: token not saved: ESP_ERR_NVS_NOT_ENOUGH_SPACE");
    CHECK_FALSE(out.reconnect);
    CHECK(app.screenName() == "setup_pair");
    CHECK(rows(app)[0].rfind("nvs: token not saved:", 0) == 0);
    CHECK(contains(allText(app), "ESP_ERR_NVS_NOT_ENOUGH_SPACE"));
    CHECK_FALSE(contains(allText(app), "paired"));
    CHECK(contains(allText(app), "code 0/8"));
    type(app, "7KQ2M9XA");
    CHECK(press(app, named(KeyName::Enter)).pair.has_value());
}

TEST_CASE("a token result nobody asked for is ignored")
{
    App app = onPair();
    const App::Out out = app.onTokenStored(true, "");
    CHECK_FALSE(out.reconnect);
    CHECK(app.screenName() == "setup_pair");
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

TEST_CASE("escape from a pair screen opened without a scan goes to the wifi list and asks for one")
{
    App app = onPair();
    const App::Out out = press(app, named(KeyName::Esc));
    CHECK(app.screenName() == "setup_wifi");
    CHECK(out.scanWifi);
    CHECK(contains(allText(app), "scanning"));
}

TEST_CASE("backspace on an empty code does the same, also after a 4401")
{
    App app = live();
    app.onAuthRejected();
    const App::Out out = press(app, named(KeyName::Backspace));
    CHECK(app.screenName() == "setup_wifi");
    CHECK(out.scanWifi);
}

TEST_CASE("escape from a pair screen reached from a scanned list does not scan again")
{
    App app = onList();
    press(app, named(KeyName::Tab));
    const App::Out out = press(app, named(KeyName::Esc));
    CHECK(app.screenName() == "setup_wifi");
    CHECK_FALSE(out.scanWifi);
    CHECK(contains(allText(app), "corner-cafe"));
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
    app.onBoot(false, false, true);
    app.onLinkStatus("starting", tick());
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

TEST_CASE("setup screens count as editing from the first frame")
{
    App app(kCaps, 7);
    app.onBoot(true, false, true);
    CHECK(app.screenName() == "setup_pair");
    CHECK(app.editing());
    App noWifi(kCaps, 7);
    noWifi.onBoot(false, false, true);
    CHECK(noWifi.screenName() == "setup_wifi");
    CHECK(noWifi.editing());
}

TEST_CASE("a boot fault shows on row 0 of setup until a key")
{
    App app(kCaps, 7);
    app.onBoot(false, false, true);
    app.onDeviceError("settings reset: nvs ESP_ERR_NVS_NEW_VERSION_FOUND, wifi and token lost");
    CHECK(rows(app)[0].rfind("settings reset: nvs", 0) == 0);
    app.onWifiScan(kNets);
    CHECK(rows(app)[0].rfind("settings reset: nvs", 0) == 0);
}

TEST_CASE("no relay url opens the relay screen and says where to get one")
{
    App app(kCaps, 7);
    const App::Out out = app.onBoot(false, false, false);
    CHECK(app.screenName() == "setup_relay");
    CHECK_FALSE(out.scanWifi);
    CHECK(app.editing());
    CHECK(rows(app)[0].rfind("relay: not set, type your relay url", 0) == 0);
    CHECK(contains(allText(app), "(setup.sh prints it)"));
}

TEST_CASE("a typed relay url is handed out normalized to save")
{
    App app(kCaps, 7);
    app.onBoot(false, false, false);
    type(app, "relay.example.com:8443");
    CHECK(contains(allText(app), "> relay.example.com:8443_"));
    const App::Out out = press(app, named(KeyName::Enter));
    REQUIRE(out.relayUrl.has_value());
    CHECK(*out.relayUrl == "https://relay.example.com:8443");
}

TEST_CASE("an invalid relay url shows the parse error and keeps the text")
{
    App app(kCaps, 7);
    app.onBoot(false, false, false);
    type(app, "http://relay.example.com");
    const App::Out out = press(app, named(KeyName::Enter));
    CHECK_FALSE(out.relayUrl.has_value());
    CHECK(app.screenName() == "setup_relay");
    CHECK(rows(app)[0].rfind("relay url must be https:// or wss://", 0) == 0);
    CHECK(contains(allText(app), "> http://relay.example.com_"));
}

TEST_CASE("the relay url stops at its budget and names it")
{
    App app(kCaps, 7);
    app.onBoot(false, false, false);
    type(app, std::string(320, 'a'));
    press(app, ch('b'));
    CHECK(rows(app)[0].rfind("relay_url_max=320, url needed 321", 0) == 0);
    CHECK(contains(allText(app), "url 320/320"));
}

TEST_CASE("with no relay url there is nowhere to go back to")
{
    App app(kCaps, 7);
    app.onBoot(true, true, false);
    press(app, named(KeyName::Esc));
    CHECK(app.screenName() == "setup_relay");
    press(app, named(KeyName::Backspace));
    CHECK(app.screenName() == "setup_relay");
}

TEST_CASE("fn+s shows the relay host on the setup list, and enter edits it prefilled")
{
    App app = live();
    app.setRelayUrl("https://relay.example.com:8443");
    press(app, named(KeyName::FnS));
    app.onWifiScan(kNets);
    CHECK(rows(app)[6].rfind("relay relay.example.com:8443", 0) == 0);
    CHECK_FALSE(contains(allText(app), "https://"));
    for (int i = 0; i < 4; ++i) {
        press(app, named(KeyName::Down));
    }
    CHECK(selectedRow(app) == 6);
    press(app, named(KeyName::Enter));
    CHECK(app.screenName() == "setup_relay");
    CHECK(contains(allText(app), "> relay.example.com:8443_"));
    press(app, named(KeyName::Esc));
    CHECK(app.screenName() == "setup_wifi");
}

TEST_CASE("saving the relay url it already has changes nothing")
{
    App app = live();
    app.setRelayUrl("https://relay.example.com:8443");
    press(app, named(KeyName::FnS));
    app.onWifiScan(kNets);
    for (int i = 0; i < 4; ++i) {
        press(app, named(KeyName::Down));
    }
    press(app, named(KeyName::Enter));
    const App::Out same = press(app, named(KeyName::Enter));
    CHECK_FALSE(same.relayUrl.has_value());
    CHECK(app.screenName() == "setup_wifi");
    CHECK(rows(app)[0].rfind("relay unchanged", 0) == 0);
}

TEST_CASE("a different relay url from the list is handed out to save")
{
    App app = live();
    app.setRelayUrl("https://relay.example.com:8443");
    press(app, named(KeyName::FnS));
    app.onWifiScan(kNets);
    for (int i = 0; i < 4; ++i) {
        press(app, named(KeyName::Down));
    }
    press(app, named(KeyName::Enter));
    for (int i = 0; i < 4; ++i) {
        press(app, named(KeyName::Backspace));
    }
    type(app, "9443");
    const App::Out out = press(app, named(KeyName::Enter));
    REQUIRE(out.relayUrl.has_value());
    CHECK(*out.relayUrl == "https://relay.example.com:9443");
}

TEST_CASE("relay screen matches the setup look")
{
    App app(kCaps, 7);
    app.onBoot(false, false, false);
    type(app, "relay.example.com:8443");
    checkGolden(app, "setup_relay");
}
