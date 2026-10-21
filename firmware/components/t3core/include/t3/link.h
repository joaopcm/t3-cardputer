#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "t3/protocol.h"

namespace t3 {

// why: the relay is back 0.24 s after a restart (241-249 ms over 5 starts, relay/deploy/t3-cardputer-relay.service); 500 ms is a tripwire past that, so the first retry lands after a restart and never before it
inline constexpr uint32_t kBackoffMinMs = 500;
// receipt: docs/receipts/2026-10-21-firmware-network.md "backoff": a retry costs one 3.8 s TLS connect and ~50 KB of transient heap on the ADV, so at 30 s retries hold the radio and CPU at most ~13% of an outage and a relay that comes back is reached within 30 s
inline constexpr uint32_t kBackoffMaxMs = 30000;
// receipt: relay/src/config.ts helloTimeoutMs=10000 (relay answers 4408 at 10 s) + 2000 ms margin, so a live relay speaks first
inline constexpr uint32_t kHelloWaitMs = 12000;
// why: tripwire past any good TLS connect, so only a wedged connect touches it; receipt: docs/receipts/2026-10-21-firmware-network.md "connect", worst measured connect 11.1 s on home WiFi (7.2 s DNS + 3.8 s TLS and upgrade), 30 s is 2.7x
inline constexpr uint32_t kConnectWaitMs = 30000;
// receipt: relay/src/config.ts heartbeatIntervalMs=30000 x heartbeatMaxMissed=2, the relay terminates a socket that stays silent this long
inline constexpr uint32_t kRelaySilentDropMs = 60000;
// receipt: docs/receipts/2026-10-21-firmware-network.md "dead link", a dead socket is found at most ping + pong + 1 s poll = 36 s after it dies, inside the relay's 60 s
inline constexpr uint32_t kPingIntervalSec = 10;
inline constexpr uint32_t kPongTimeoutSec = 25;

class Link {
public:
    enum class State { NoWifi, Connecting, Hello, Live, Backoff, NeedsPair, Stopped };

    struct Out {
        std::vector<std::string> send;
        bool wipeToken = false;
        std::optional<uint32_t> reconnectInMs;
        std::optional<std::string> statusText;
        bool connect = false;
        bool closeSocket = false;
        bool passToApp = false;
    };

    Link(const HelloCaps &caps, std::string token, std::string fw);

    void setToken(std::string token);

    Out onWifi(bool up, uint32_t nowMs);
    Out onOpen(uint32_t nowMs);
    Out onText(std::string_view frame, uint32_t nowMs);
    Out onClose(int code, std::string_view lastError, uint32_t nowMs);
    Out onTick(uint32_t nowMs);
    Out onUserReconnect(uint32_t nowMs);

    State state() const { return state_; }
    bool canPair() const { return state_ == State::NeedsPair || state_ == State::Stopped; }

private:
    Out connectNow(uint32_t nowMs);
    Out retryAfter(std::string statusText, uint32_t nowMs);
    Out onPreWelcome(std::string_view frame, uint32_t nowMs);

    HelloCaps caps_;
    std::string token_;
    std::string fw_;
    State state_ = State::NoWifi;
    bool wifiUp_ = false;
    uint32_t backoffMs_ = kBackoffMinMs;
    uint32_t deadlineMs_ = 0;
    std::string lastError_;
};

}
