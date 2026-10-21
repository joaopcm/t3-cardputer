#include "doctest.h"

#include <cstdlib>
#include <string>

#include "cJSON.h"
#include "t3/link.h"
#include "t3/protocol.h"

namespace {

const t3::HelloCaps kCaps{40, 8, 4096, 8};
const char *kWelcome = R"({"type":"welcome","v":1,"relay":"0.1.0"})";
const char *kHome = R"({"type":"home","rows":[],"counts":{"needs":0,"running":0,"done":0},"approvals":{"available":true},"warnings":[],"warningsDropped":0,"t3":"ok"})";

t3::Link makeLink()
{
    return t3::Link(kCaps, "tok-123", "0.1.0");
}

t3::Link connecting()
{
    t3::Link link = makeLink();
    link.onWifi(true, 0);
    return link;
}

t3::Link live()
{
    t3::Link link = connecting();
    link.onOpen(0);
    link.onText(kWelcome, 0);
    return link;
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

TEST_CASE("a new link waits for wifi, wifi up connects")
{
    t3::Link link = makeLink();
    CHECK(link.state() == t3::Link::State::NoWifi);
    const auto out = link.onWifi(true, 0);
    CHECK(link.state() == t3::Link::State::Connecting);
    CHECK(out.statusText == "connecting");
    CHECK(out.connect);
    CHECK(out.send.empty());
}

TEST_CASE("wifi down shows wifi down and drops the socket")
{
    t3::Link link = live();
    const auto out = link.onWifi(false, 0);
    CHECK(link.state() == t3::Link::State::NoWifi);
    CHECK(out.statusText == "wifi down");
    CHECK(out.closeSocket);
    CHECK_FALSE(out.reconnectInMs);
}

TEST_CASE("a close while wifi is down schedules nothing")
{
    t3::Link link = live();
    link.onWifi(false, 0);
    const auto out = link.onClose(1006, "", 0);
    CHECK(link.state() == t3::Link::State::NoWifi);
    CHECK_FALSE(out.reconnectInMs);
    CHECK_FALSE(out.connect);
}

TEST_CASE("open sends hello first and nothing else until welcome")
{
    t3::Link link = connecting();
    CHECK(link.state() == t3::Link::State::Connecting);

    const auto opened = link.onOpen(0);
    CHECK(link.state() == t3::Link::State::Hello);
    REQUIRE(opened.send.size() == 1);
    CHECK(opened.send[0] == *t3::encodeHello(kCaps, "tok-123", "0.1.0"));

    const auto ticked = link.onTick(5000);
    CHECK(ticked.send.empty());
    CHECK(link.state() == t3::Link::State::Hello);

    const auto welcomed = link.onText(kWelcome, 0);
    CHECK(welcomed.send.empty());
    CHECK(link.state() == t3::Link::State::Live);
}

TEST_CASE("nothing is sent before open")
{
    t3::Link link = makeLink();
    CHECK(link.onWifi(true, 0).send.empty());
    CHECK(link.onTick(1000).send.empty());
}

TEST_CASE("a hello that cannot be encoded names the heap and retries without sending")
{
    t3::Link link = connecting();
    const FailingAllocator failing;
    const auto out = link.onOpen(0);
    CHECK(out.send.empty());
    CHECK(out.statusText == "heap: hello needed more than available");
    CHECK(out.closeSocket);
    CHECK(out.reconnectInMs == t3::kBackoffMinMs);
    CHECK(link.state() == t3::Link::State::Backoff);
}

TEST_CASE("frames after welcome pass through to the app unparsed")
{
    t3::Link link = live();
    const auto out = link.onText(kHome, 0);
    CHECK(out.passToApp);
    CHECK_FALSE(out.statusText.has_value());
    CHECK(link.state() == t3::Link::State::Live);

    const auto garbage = link.onText("{not json", 0);
    CHECK(garbage.passToApp);
    CHECK_FALSE(garbage.statusText.has_value());
}

TEST_CASE("a pre-welcome frame that fails to parse shows the parse error and retries")
{
    t3::Link link = connecting();
    link.onOpen(0);
    const auto out = link.onText(R"({"type":"welcome","v":"one","relay":"0.1.0"})", 0);
    CHECK(out.statusText.has_value());
    CHECK(out.statusText->find("v") != std::string::npos);
    CHECK_FALSE(out.passToApp);
    CHECK(out.closeSocket);
    CHECK(out.reconnectInMs == t3::kBackoffMinMs);
    CHECK(link.state() == t3::Link::State::Backoff);
}

TEST_CASE("garbage before welcome shows the parse error")
{
    t3::Link link = connecting();
    link.onOpen(0);
    const auto out = link.onText("{not json", 0);
    CHECK(out.statusText.has_value());
    CHECK(link.state() == t3::Link::State::Backoff);
}

TEST_CASE("a frame other than welcome or error before welcome is shown, not forwarded")
{
    t3::Link link = connecting();
    link.onOpen(0);
    const auto out = link.onText(kHome, 0);
    CHECK_FALSE(out.passToApp);
    CHECK(out.statusText == "relay sent a frame before welcome");
    CHECK(link.state() == t3::Link::State::Backoff);
}

TEST_CASE("an error frame before welcome shows its message and waits for the close")
{
    t3::Link link = connecting();
    link.onOpen(0);
    const auto out = link.onText(R"({"type":"error","code":"auth","message":"token rejected"})", 0);
    CHECK(out.statusText == "token rejected");
    CHECK(link.state() == t3::Link::State::Hello);
    CHECK_FALSE(out.closeSocket);
}

TEST_CASE("4408 reconnects and keeps the token")
{
    t3::Link link = connecting();
    link.onOpen(0);
    const auto out = link.onClose(4408, "no hello within helloTimeoutMs=10000", 0);
    CHECK_FALSE(out.wipeToken);
    CHECK(out.reconnectInMs == t3::kBackoffMinMs);
    CHECK(out.statusText == "relay unreachable: no hello within helloTimeoutMs=10000");
    CHECK(link.state() == t3::Link::State::Backoff);

    const auto fired = link.onTick(t3::kBackoffMinMs);
    CHECK(fired.connect);
    link.onOpen(0);
    CHECK(link.state() == t3::Link::State::Hello);
}

TEST_CASE("the token is sent again on reconnect")
{
    t3::Link link = connecting();
    link.onOpen(0);
    link.onClose(4408, "stalled", 0);
    link.onTick(t3::kBackoffMinMs);
    const auto opened = link.onOpen(0);
    REQUIRE(opened.send.size() == 1);
    CHECK(opened.send[0] == *t3::encodeHello(kCaps, "tok-123", "0.1.0"));
}

TEST_CASE("4401 wipes the token and stops reconnecting")
{
    t3::Link link = live();
    const auto out = link.onClose(4401, "device revoked, re-pair this device", 0);
    CHECK(out.wipeToken);
    CHECK(out.statusText == "re-pair needed");
    CHECK_FALSE(out.reconnectInMs);
    CHECK(link.state() == t3::Link::State::NeedsPair);
    CHECK_FALSE(link.onTick(10 * t3::kBackoffMaxMs).connect);
}

TEST_CASE("1006 backs off doubling to the max")
{
    t3::Link link = connecting();
    uint32_t expected = t3::kBackoffMinMs;
    uint32_t now = 0;
    for (int attempt = 0; attempt < 20; attempt++) {
        const auto out = link.onClose(1006, "", now);
        REQUIRE(out.reconnectInMs.has_value());
        CHECK(*out.reconnectInMs == expected);
        CHECK_FALSE(out.wipeToken);
        CHECK(out.statusText == "relay unreachable: closed 1006");
        CHECK(link.state() == t3::Link::State::Backoff);

        CHECK_FALSE(link.onTick(now + expected - 1).connect);
        now += expected;
        CHECK(link.onTick(now).connect);
        CHECK(link.state() == t3::Link::State::Connecting);
        expected = expected * 2 > t3::kBackoffMaxMs ? t3::kBackoffMaxMs : expected * 2;
    }
    CHECK(expected == t3::kBackoffMaxMs);
}

TEST_CASE("welcome resets backoff")
{
    t3::Link link = connecting();
    link.onClose(1006, "", 0);
    link.onTick(1000000);
    link.onClose(1006, "", 0);
    link.onTick(2000000);
    const auto third = link.onClose(1006, "", 0);
    CHECK(*third.reconnectInMs == 4 * t3::kBackoffMinMs);

    link.onTick(3000000);
    link.onOpen(0);
    link.onText(kWelcome, 0);
    const auto after = link.onClose(1006, "", 0);
    CHECK(*after.reconnectInMs == t3::kBackoffMinMs);
}

TEST_CASE("the close that follows a socket the link dropped does not advance backoff")
{
    t3::Link link = connecting();
    link.onOpen(0);
    const auto dropped = link.onText("{not json", 0);
    CHECK(dropped.closeSocket);
    CHECK(dropped.reconnectInMs == t3::kBackoffMinMs);
    const auto stale = link.onClose(1000, "", 0);
    CHECK_FALSE(stale.reconnectInMs);
    CHECK_FALSE(stale.statusText.has_value());
    CHECK_FALSE(link.onTick(t3::kBackoffMinMs - 1).connect);
    CHECK(link.onTick(t3::kBackoffMinMs).connect);
    CHECK(*link.onClose(1006, "", 0).reconnectInMs == 2 * t3::kBackoffMinMs);
}

TEST_CASE("open alone does not reset backoff")
{
    t3::Link link = connecting();
    link.onClose(1006, "", 0);
    link.onTick(1000000);
    link.onOpen(0);
    const auto out = link.onClose(1006, "", 0);
    CHECK(*out.reconnectInMs == 2 * t3::kBackoffMinMs);
}

TEST_CASE("4400 update relay shows update relay and stops")
{
    t3::Link link = connecting();
    link.onOpen(0);
    const auto out = link.onClose(4400, "update relay: device protocol v=2, relay v=1", 0);
    CHECK(out.statusText == "update relay: device protocol v=2, relay v=1");
    CHECK_FALSE(out.wipeToken);
    CHECK_FALSE(out.reconnectInMs);
    CHECK(link.state() == t3::Link::State::Stopped);
}

TEST_CASE("4400 update firmware shows update firmware and stops")
{
    t3::Link link = connecting();
    link.onOpen(0);
    const auto out = link.onClose(4400, "update firmware: device protocol v=1, relay v=2", 0);
    CHECK(out.statusText->rfind("update firmware", 0) == 0);
    CHECK(link.state() == t3::Link::State::Stopped);
}

TEST_CASE("4402 shows the relay's error message and stops")
{
    t3::Link link = connecting();
    link.onOpen(0);
    const auto out = link.onClose(4402, "hello.cols: must be at most 255", 0);
    CHECK(out.statusText == "hello.cols: must be at most 255");
    CHECK(out.reconnectInMs == std::nullopt);
    CHECK_FALSE(out.wipeToken);
    CHECK(link.state() == t3::Link::State::Stopped);
}

TEST_CASE("4402 falls back to the error frame the link saw when the caller passes none")
{
    t3::Link link = connecting();
    link.onOpen(0);
    link.onText(R"({"type":"error","code":"bad_message","message":"hello.cols: must be at most 255"})", 0);
    const auto out = link.onClose(4402, "", 0);
    CHECK(out.statusText == "hello.cols: must be at most 255");
}

TEST_CASE("4000 shows replaced and stops until the user reconnects")
{
    t3::Link link = live();
    const auto out = link.onClose(4000, "", 0);
    CHECK(out.statusText == "replaced by another connection");
    CHECK_FALSE(out.wipeToken);
    CHECK_FALSE(out.reconnectInMs);
    CHECK(link.state() == t3::Link::State::Stopped);
    CHECK_FALSE(link.onTick(10 * t3::kBackoffMaxMs).connect);
    CHECK_FALSE(link.onWifi(false, 0).connect);
    CHECK(link.state() == t3::Link::State::Stopped);
    CHECK_FALSE(link.onWifi(true, 0).connect);
    CHECK(link.state() == t3::Link::State::Stopped);

    const auto again = link.onUserReconnect(0);
    CHECK(again.connect);
    CHECK(again.statusText == "connecting");
    CHECK(link.state() == t3::Link::State::Connecting);
}

TEST_CASE("user reconnect with wifi down shows wifi down")
{
    t3::Link link = live();
    link.onClose(4000, "", 0);
    link.onWifi(false, 0);
    const auto out = link.onUserReconnect(0);
    CHECK_FALSE(out.connect);
    CHECK(out.statusText == "wifi down");
    CHECK(link.state() == t3::Link::State::NoWifi);
}

TEST_CASE("user reconnect does nothing while connected or backing off")
{
    t3::Link link = live();
    CHECK_FALSE(link.onUserReconnect(0).connect);
    CHECK(link.state() == t3::Link::State::Live);
    link.onClose(1006, "", 0);
    CHECK_FALSE(link.onUserReconnect(0).connect);
    CHECK(link.state() == t3::Link::State::Backoff);
}

TEST_CASE("after re-pair the user reconnects with the new token")
{
    t3::Link link = live();
    link.onClose(4401, "device revoked, re-pair this device", 0);
    link.setToken("fresh-token");
    const auto again = link.onUserReconnect(0);
    CHECK(again.connect);
    const auto opened = link.onOpen(0);
    REQUIRE(opened.send.size() == 1);
    CHECK(opened.send[0] == *t3::encodeHello(kCaps, "fresh-token", "0.1.0"));
}

TEST_CASE("after 4401 the user cannot reconnect without a new token")
{
    t3::Link link = live();
    link.onClose(4401, "", 0);
    const auto out = link.onUserReconnect(0);
    CHECK_FALSE(out.connect);
    CHECK(out.send.empty());
    CHECK(out.statusText == "re-pair needed");
    CHECK(link.state() == t3::Link::State::NeedsPair);
}

TEST_CASE("a link built without a token never sends hello and asks for pairing")
{
    t3::Link link(kCaps, "", "0.1.0");
    const auto out = link.onWifi(true, 0);
    CHECK_FALSE(out.connect);
    CHECK(out.send.empty());
    CHECK(out.statusText == "re-pair needed");
    CHECK(link.state() == t3::Link::State::NeedsPair);
    CHECK_FALSE(link.onUserReconnect(0).connect);
    CHECK(link.state() == t3::Link::State::NeedsPair);
}

TEST_CASE("an empty token set after pairing cannot connect either")
{
    t3::Link link = connecting();
    link.onClose(1006, "", 0);
    link.setToken("");
    const auto out = link.onTick(t3::kBackoffMinMs);
    CHECK_FALSE(out.connect);
    CHECK(out.statusText == "re-pair needed");
    CHECK(link.state() == t3::Link::State::NeedsPair);
}

TEST_CASE("a connect that never opens times out, closes the socket and backs off")
{
    t3::Link link = makeLink();
    link.onWifi(true, 5000);
    const auto early = link.onTick(5000 + t3::kConnectWaitMs - 1);
    CHECK_FALSE(early.closeSocket);
    CHECK_FALSE(early.statusText.has_value());
    CHECK(link.state() == t3::Link::State::Connecting);

    const auto out = link.onTick(5000 + t3::kConnectWaitMs);
    CHECK(out.closeSocket);
    CHECK(out.reconnectInMs == t3::kBackoffMinMs);
    CHECK(out.statusText == "relay unreachable: no connection within kConnectWaitMs=30000");
    CHECK(link.state() == t3::Link::State::Backoff);
    CHECK_FALSE(link.onClose(1006, "", 5000 + t3::kConnectWaitMs).reconnectInMs);

    const uint32_t retryAt = 5000 + t3::kConnectWaitMs + t3::kBackoffMinMs;
    CHECK_FALSE(link.onTick(retryAt - 1).connect);
    CHECK(link.onTick(retryAt).connect);
}

TEST_CASE("a hello that gets no welcome times out, closes the socket and backs off")
{
    t3::Link link = connecting();
    link.onOpen(1000);
    const auto early = link.onTick(1000 + t3::kHelloWaitMs - 1);
    CHECK_FALSE(early.closeSocket);
    CHECK_FALSE(early.statusText.has_value());
    CHECK(link.state() == t3::Link::State::Hello);

    const auto out = link.onTick(1000 + t3::kHelloWaitMs);
    CHECK(out.closeSocket);
    CHECK(out.reconnectInMs == t3::kBackoffMinMs);
    CHECK(out.statusText == "relay unreachable: no welcome within kHelloWaitMs=12000");
    CHECK(link.state() == t3::Link::State::Backoff);
}

TEST_CASE("welcome cancels the hello deadline")
{
    t3::Link link = connecting();
    link.onOpen(1000);
    link.onText(kWelcome, 2000);
    const auto out = link.onTick(1000 + t3::kHelloWaitMs + 1);
    CHECK_FALSE(out.closeSocket);
    CHECK_FALSE(out.statusText.has_value());
    CHECK(link.state() == t3::Link::State::Live);
}

TEST_CASE("a quiet driver cannot collapse backoff, the deadline starts at the close")
{
    t3::Link link = connecting();
    link.onTick(0);
    const auto out = link.onClose(1006, "", 10000);
    CHECK(out.reconnectInMs == t3::kBackoffMinMs);
    CHECK_FALSE(link.onTick(10000 + t3::kBackoffMinMs - 1).connect);
    CHECK(link.onTick(10000 + t3::kBackoffMinMs).connect);
}

TEST_CASE("the connect deadline starts at the wifi event, not the last tick")
{
    t3::Link link = makeLink();
    link.onTick(0);
    link.onWifi(true, 20000);
    CHECK_FALSE(link.onTick(20000 + t3::kConnectWaitMs - 1).closeSocket);
    CHECK(link.onTick(20000 + t3::kConnectWaitMs).closeSocket);
}

TEST_CASE("welcome clears a prior relay unreachable status")
{
    t3::Link link = connecting();
    const auto closed = link.onClose(1006, "", 0);
    CHECK(closed.statusText == "relay unreachable: closed 1006");
    link.onTick(t3::kBackoffMinMs);
    link.onOpen(t3::kBackoffMinMs);
    const auto welcomed = link.onText(kWelcome, t3::kBackoffMinMs);
    REQUIRE(welcomed.statusText.has_value());
    CHECK(*welcomed.statusText == "");
}

TEST_CASE("a tick with nothing happening leaves the status alone")
{
    t3::Link link = live();
    const auto out = link.onTick(1000);
    CHECK_FALSE(out.statusText.has_value());
    CHECK_FALSE(out.reconnectInMs.has_value());
    CHECK_FALSE(out.connect);
    CHECK_FALSE(out.closeSocket);
    CHECK_FALSE(link.onTick(0).statusText.has_value());
}

TEST_CASE("an unknown close code reconnects with backoff and keeps the token")
{
    t3::Link link = live();
    const auto out = link.onClose(1009, "", 0);
    CHECK_FALSE(out.wipeToken);
    CHECK(out.reconnectInMs == t3::kBackoffMinMs);
    CHECK(out.statusText == "relay unreachable: closed 1009");
}

TEST_CASE("the relay's own heartbeat needs no link timer, a quiet live link stays live")
{
    t3::Link link = live();
    for (uint32_t now = 0; now < 10 * 60 * 1000; now += 1000) {
        const auto out = link.onTick(now);
        CHECK(out.send.empty());
        CHECK_FALSE(out.connect);
    }
    CHECK(link.state() == t3::Link::State::Live);
}

TEST_CASE("pairing is allowed only while the link needs a token or has stopped")
{
    CHECK_FALSE(makeLink().canPair());
    CHECK_FALSE(connecting().canPair());
    CHECK_FALSE(live().canPair());
    t3::Link backingOff = live();
    backingOff.onClose(1006, "", 0);
    CHECK_FALSE(backingOff.canPair());

    t3::Link unpaired(kCaps, "", "0.1.0");
    unpaired.onWifi(true, 0);
    CHECK(unpaired.canPair());

    t3::Link rejected = live();
    rejected.onClose(4401, "", 0);
    CHECK(rejected.canPair());

    t3::Link stopped = connecting();
    stopped.onOpen(0);
    stopped.onClose(4402, "hello.cols: must be at most 255", 0);
    CHECK(stopped.canPair());
}
