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
// receipt: pending Task 8 (hotspot reconnect measurements)
inline constexpr uint32_t kBackoffMaxMs = 30000;

class Link {
public:
    enum class State { NoWifi, Connecting, Hello, Live, Backoff, NeedsPair, Stopped };

    struct Out {
        std::vector<std::string> send;
        bool wipeToken = false;
        std::optional<uint32_t> reconnectInMs;
        std::string statusText;
        bool connect = false;
        bool closeSocket = false;
        bool passToApp = false;
    };

    Link(const HelloCaps &caps, std::string token, std::string fw);

    void setToken(std::string token);

    Out onWifi(bool up);
    Out onOpen();
    Out onText(std::string_view frame);
    Out onClose(int code, std::string_view lastError);
    Out onTick(uint32_t nowMs);
    Out onUserReconnect();

    State state() const { return state_; }

private:
    Out connectNow();
    Out retryAfter(std::string statusText);
    Out onPreWelcome(std::string_view frame);

    HelloCaps caps_;
    std::string token_;
    std::string fw_;
    State state_ = State::NoWifi;
    bool wifiUp_ = false;
    uint32_t backoffMs_ = kBackoffMinMs;
    uint32_t nowMs_ = 0;
    uint32_t retryAtMs_ = 0;
    std::string lastError_;
};

}
