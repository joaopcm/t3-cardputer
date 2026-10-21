#include "doctest.h"

#include "t3/wifi_station.h"

namespace {

using t3::WifiEvent;
using t3::WifiJoin;
using t3::WifiNet;
using t3::WifiStation;

struct FakeDriver : t3::WifiDriver {
    std::optional<std::string> startScan() override
    {
        ++scans;
        return std::nullopt;
    }
    std::optional<std::string> connect(const WifiJoin &cred) override
    {
        joins.push_back(cred.ssid);
        return std::nullopt;
    }
    void disconnect() override { ++disconnects; }
    t3::SavedWifi saved() override { return saved_; }

    t3::SavedWifi saved_{{{"home", "password1"}, {"phone", "password2"}}, std::nullopt};
    int scans = 0;
    int disconnects = 0;
    std::vector<std::string> joins;
};

const std::vector<WifiNet> kInRange = {{"home", -40, true, false}, {"phone", -60, true, false}};

std::vector<WifiEvent> drain(WifiStation &station, uint32_t nowMs)
{
    std::vector<WifiEvent> events;
    while (std::optional<WifiEvent> event = station.poll(nowMs)) {
        events.push_back(*event);
    }
    return events;
}

void joiningHome(WifiStation &station, FakeDriver &driver)
{
    station.start(0);
    drain(station, 0);
    REQUIRE(driver.scans == 1);
    station.onScanDone(kInRange, false, 0);
    drain(station, 0);
    REQUIRE(driver.joins == std::vector<std::string>{"home"});
}

}

TEST_CASE("a join that times out waits for the driver's disconnect before trying the next saved network")
{
    FakeDriver driver;
    WifiStation station(driver);
    joiningHome(station, driver);

    drain(station, t3::kWifiJoinWaitMs);
    CHECK(driver.disconnects == 1);
    CHECK(driver.joins == std::vector<std::string>{"home"});

    station.onDisconnected("reason 8", t3::kWifiJoinWaitMs + 50);
    const std::vector<WifiEvent> events = drain(station, t3::kWifiJoinWaitMs + 50);
    CHECK(driver.joins == std::vector<std::string>{"home", "phone"});
    REQUIRE(events.size() == 1);
    CHECK(events[0].text == "wifi: home failed, no ip within kWifiJoinWaitMs=20000, joining phone");

    station.onGotIp();
    const std::vector<WifiEvent> up = drain(station, t3::kWifiJoinWaitMs + 900);
    REQUIRE(up.size() == 1);
    CHECK(up[0].kind == WifiEvent::Kind::Up);
    CHECK(up[0].text == "phone");
}

TEST_CASE("a timed-out join whose disconnect never comes moves on at the leave deadline")
{
    FakeDriver driver;
    WifiStation station(driver);
    joiningHome(station, driver);

    drain(station, t3::kWifiJoinWaitMs);
    drain(station, 2 * t3::kWifiJoinWaitMs - 1);
    CHECK(driver.joins == std::vector<std::string>{"home"});
    drain(station, 2 * t3::kWifiJoinWaitMs);
    CHECK(driver.joins == std::vector<std::string>{"home", "phone"});
}

TEST_CASE("a typed join during a timed-out join's disconnect joins the typed network once it lands")
{
    FakeDriver driver;
    WifiStation station(driver);
    joiningHome(station, driver);
    drain(station, t3::kWifiJoinWaitMs);

    station.join(WifiJoin{"attic", "password3"}, t3::kWifiJoinWaitMs + 10);
    CHECK(driver.disconnects == 1);
    station.onDisconnected("reason 8", t3::kWifiJoinWaitMs + 50);
    const std::vector<WifiEvent> events = drain(station, t3::kWifiJoinWaitMs + 50);
    CHECK(driver.joins == std::vector<std::string>{"home", "attic"});
    REQUIRE(events.size() == 1);
    CHECK(events[0].text == "wifi: home failed, no ip within kWifiJoinWaitMs=20000, joining attic");
}

TEST_CASE("an unreadable saved list names its error instead of saying none are saved")
{
    FakeDriver driver;
    driver.saved_ = {{}, std::string("nvs: saved networks unreadable: ESP_ERR_NVS_INVALID_LENGTH")};
    WifiStation station(driver);
    station.start(0);
    drain(station, 0);
    station.onScanDone(kInRange, false, 0);
    const std::vector<WifiEvent> events = drain(station, 0);
    REQUIRE(events.size() == 1);
    CHECK(events[0].text == "wifi: nvs: saved networks unreadable: ESP_ERR_NVS_INVALID_LENGTH");
}

TEST_CASE("a join the access point refuses tries the next saved network at once")
{
    FakeDriver driver;
    WifiStation station(driver);
    joiningHome(station, driver);

    station.onDisconnected("reason 2", 100);
    const std::vector<WifiEvent> events = drain(station, 100);
    CHECK(driver.joins == std::vector<std::string>{"home", "phone"});
    REQUIRE(events.size() == 1);
    CHECK(events[0].text == "wifi: home failed, reason 2, joining phone");
}

TEST_CASE("a saved network forgotten mid-round counts as failed and the next one is tried")
{
    FakeDriver driver;
    driver.saved_ = {{{"home", "password1"}, {"phone", "password2"}, {"attic", "password3"}}, std::nullopt};
    WifiStation station(driver);
    station.start(0);
    drain(station, 0);
    station.onScanDone({{"home", -40, true, false}, {"phone", -60, true, false}, {"attic", -70, true, false}}, false, 0);
    drain(station, 0);
    REQUIRE(driver.joins == std::vector<std::string>{"home"});

    driver.saved_ = {{{"home", "password1"}, {"attic", "password3"}}, std::nullopt};
    station.onDisconnected("reason 2", 100);
    const std::vector<WifiEvent> events = drain(station, 100);
    CHECK(driver.joins == std::vector<std::string>{"home", "attic"});
    REQUIRE(events.size() == 1);
    CHECK(events[0].text == "wifi: home failed, reason 2, joining attic");
}
