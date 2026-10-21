#include <algorithm>

#include "doctest.h"

#include "t3/wifi_pick.h"

namespace {

using t3::WifiNet;
using t3::WifiPicker;

const std::vector<WifiNet> kNets = {
    {"cafe", -40, true, false},
    {"phone", -60, true, true},
    {"home", -50, true, true},
};

}

TEST_CASE("the strongest saved network in range goes first")
{
    WifiPicker picker;
    picker.scanned(kNets, {"phone", "home"}, false);
    CHECK(picker.next() == "home");
}

TEST_CASE("a failed network falls back to the next strongest saved one, then to none")
{
    WifiPicker picker;
    picker.scanned(kNets, {"phone", "home"}, false);
    picker.failed("home");
    CHECK(picker.next() == "phone");
    picker.failed("phone");
    CHECK_FALSE(picker.next().has_value());
}

TEST_CASE("the same scan keeps the round, a finished round starts over at the strongest")
{
    WifiPicker picker;
    picker.scanned(kNets, {"phone", "home"}, false);
    picker.failed("home");
    picker.scanned(kNets, {"phone", "home"}, false);
    CHECK(picker.next() == "phone");
    picker.failed("phone");
    picker.scanned(kNets, {"phone", "home"}, false);
    CHECK(picker.next() == "home");
}

TEST_CASE("a scan with a different set of saved networks starts a new round")
{
    WifiPicker picker;
    picker.scanned(kNets, {"phone", "home"}, false);
    picker.failed("home");
    std::vector<WifiNet> moved = kNets;
    moved.push_back({"office", -70, true, true});
    picker.scanned(moved, {"phone", "home", "office"}, false);
    CHECK(picker.next() == "home");
}

TEST_CASE("joining a network starts a new round")
{
    WifiPicker picker;
    picker.scanned(kNets, {"phone", "home"}, false);
    picker.failed("home");
    picker.joined();
    CHECK(picker.next() == "home");
}

TEST_CASE("saved networks the scan did not list are tried last, only when a hidden network is in range")
{
    WifiPicker picker;
    picker.scanned(kNets, {"attic", "phone"}, false);
    picker.failed("phone");
    CHECK_FALSE(picker.next().has_value());

    WifiPicker hidden;
    hidden.scanned(kNets, {"attic", "phone"}, true);
    CHECK(hidden.next() == "phone");
    hidden.failed("phone");
    CHECK(hidden.next() == "attic");
}

TEST_CASE("one unlisted saved network per round, a different one each round")
{
    WifiPicker picker;
    const std::vector<std::string> saved = {"attic", "barn", "cellar"};
    std::vector<std::string> reached;
    for (int round = 0; round < 3; ++round) {
        picker.scanned(kNets, saved, true);
        const std::optional<std::string> ssid = picker.next();
        REQUIRE(ssid.has_value());
        reached.push_back(*ssid);
        picker.failed(*ssid);
        CHECK_FALSE(picker.next().has_value());
    }
    std::sort(reached.begin(), reached.end());
    CHECK(reached == saved);
}

TEST_CASE("the same scan keeps the round's unlisted saved network")
{
    WifiPicker picker;
    picker.scanned(kNets, {"attic", "barn", "phone"}, true);
    picker.failed("phone");
    const std::optional<std::string> unlisted = picker.next();
    REQUIRE(unlisted.has_value());
    picker.scanned(kNets, {"attic", "barn", "phone"}, true);
    CHECK(picker.next() == unlisted);
    picker.failed(*unlisted);
    picker.scanned(kNets, {"attic", "barn", "phone"}, true);
    CHECK(picker.next() == "phone");
}

TEST_CASE("the unlisted rotation goes on after the last one tried when the unlisted set changes")
{
    WifiPicker picker;
    auto round = [&](const std::vector<std::string> &saved) {
        picker.scanned(kNets, saved, true);
        std::vector<std::string> tried;
        while (const std::optional<std::string> ssid = picker.next()) {
            tried.push_back(*ssid);
            picker.failed(*ssid);
        }
        return tried;
    };
    using Ssids = std::vector<std::string>;
    CHECK(round({"attic", "barn", "cellar"}) == Ssids{"attic"});
    CHECK(round({"attic", "barn", "cellar"}) == Ssids{"barn"});
    CHECK(round({"barn", "cellar"}) == Ssids{"cellar"});
    CHECK(round({"attic", "barn", "cellar"}) == Ssids{"attic"});
    CHECK(round({"attic", "cellar"}) == Ssids{"cellar"});
    CHECK(round({"attic", "barn", "cellar"}) == Ssids{"attic"});
}

TEST_CASE("no saved network in range has nothing to try")
{
    WifiPicker picker;
    picker.scanned(kNets, {"attic"}, false);
    CHECK_FALSE(picker.next().has_value());
}
