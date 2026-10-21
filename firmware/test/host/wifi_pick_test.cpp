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
    CHECK(picker.anyInRange());
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

TEST_CASE("no saved network in range has nothing to try")
{
    WifiPicker picker;
    picker.scanned(kNets, {"attic"}, false);
    CHECK_FALSE(picker.next().has_value());
    CHECK_FALSE(picker.anyInRange());
}
