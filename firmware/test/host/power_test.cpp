#include "doctest.h"

#include <cstdint>

#include "t3/power.h"

namespace {

using t3::Power;

constexpr uint32_t kDim = 1000;
constexpr uint32_t kOff = 3000;

Power power(uint32_t now = 0)
{
    return Power(kDim, kOff, now);
}

}

TEST_CASE("the screen stays full until the dim timeout, dims there and goes off at the off timeout")
{
    Power p = power();
    CHECK(p.level() == Power::Level::Full);
    CHECK_FALSE(p.onTick(kDim - 1));
    CHECK(p.level() == Power::Level::Full);
    CHECK(p.onTick(kDim));
    CHECK(p.level() == Power::Level::Dim);
    CHECK_FALSE(p.onTick(kOff - 1));
    CHECK(p.level() == Power::Level::Dim);
    CHECK(p.onTick(kOff));
    CHECK(p.level() == Power::Level::Off);
    CHECK_FALSE(p.onTick(kOff * 10));
}

TEST_CASE("a late tick goes straight from full to off")
{
    Power p = power();
    CHECK(p.onTick(kOff + 500));
    CHECK(p.level() == Power::Level::Off);
}

TEST_CASE("a key on a dimmed screen acts and restarts the idle clock")
{
    Power p = power();
    p.onTick(kDim);
    CHECK(p.onKey(kDim + 10) == Power::KeyEffect::Deliver);
    CHECK(p.level() == Power::Level::Full);
    CHECK_FALSE(p.onTick(kDim + 10 + kDim - 1));
    CHECK(p.onTick(kDim + 10 + kDim));
    CHECK(p.level() == Power::Level::Dim);
}

TEST_CASE("a key on a full screen restarts the idle clock")
{
    Power p = power();
    CHECK(p.onKey(kDim - 1) == Power::KeyEffect::Deliver);
    CHECK_FALSE(p.onTick(kDim));
    CHECK(p.level() == Power::Level::Full);
    CHECK(p.onTick(kDim - 1 + kDim));
}

TEST_CASE("a key on a dark screen only wakes it")
{
    Power p = power();
    p.onTick(kOff);
    REQUIRE(p.level() == Power::Level::Off);
    CHECK(p.onKey(kOff + 5) == Power::KeyEffect::Woke);
    CHECK(p.level() == Power::Level::Full);
    CHECK(p.onKey(kOff + 6) == Power::KeyEffect::Deliver);
}

TEST_CASE("after a wake the idle clock restarts from the waking key")
{
    Power p = power();
    p.onTick(kOff);
    p.onKey(kOff + 5);
    CHECK_FALSE(p.onTick(kOff + 5 + kDim - 1));
    CHECK(p.onTick(kOff + 5 + kDim));
    CHECK(p.level() == Power::Level::Dim);
}

TEST_CASE("timeouts survive the 32-bit millisecond clock wrapping")
{
    const uint32_t start = UINT32_MAX - 500;
    Power p = power(start);
    CHECK_FALSE(p.onTick(start + kDim - 1));
    CHECK(p.onTick(start + kDim));
    CHECK(p.level() == Power::Level::Dim);
    CHECK(p.onTick(start + kOff));
    CHECK(p.level() == Power::Level::Off);
    CHECK(p.onKey(start + kOff + 1) == Power::KeyEffect::Woke);
}

TEST_CASE("new timeouts restart the idle clock and wake the screen")
{
    Power p = power();
    p.onTick(kOff);
    p.setTimeouts(200, 400, kOff + 1);
    CHECK(p.level() == Power::Level::Full);
    CHECK_FALSE(p.onTick(kOff + 1 + 199));
    CHECK(p.onTick(kOff + 1 + 200));
    CHECK(p.onTick(kOff + 1 + 400));
    CHECK(p.level() == Power::Level::Off);
}
