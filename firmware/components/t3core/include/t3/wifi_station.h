#pragma once

#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "t3/app.h"
#include "t3/wifi_pick.h"

namespace t3 {

// receipt: docs/receipts/2026-10-21-firmware-network.md "wifi"
inline constexpr uint32_t kWifiJoinWaitMs = 20000;
inline constexpr uint32_t kWifiRetryMs = 10000;
// receipt: IEEE 802.11 reason code 2, "previous authentication no longer valid" (WIFI_REASON_AUTH_EXPIRE in esp_wifi_types.h)
inline constexpr int kWifiReasonAuthExpire = 2;

struct WifiEvent {
    enum class Kind { Up, Down, Scanned, Joined, JoinFailed, Status };
    Kind kind;
    std::string text;
    std::vector<WifiNet> nets;
};

struct SavedWifi {
    std::vector<WifiJoin> creds;
    std::optional<std::string> error;
};

class WifiDriver {
public:
    virtual ~WifiDriver() = default;
    virtual std::optional<std::string> startScan() = 0;
    virtual std::optional<std::string> connect(const WifiJoin &cred) = 0;
    virtual void disconnect() = 0;
    virtual SavedWifi saved() = 0;
};

class WifiStation {
public:
    explicit WifiStation(WifiDriver &driver) : driver_(driver) {}

    void start(uint32_t nowMs);
    void scan();
    void join(WifiJoin cred, uint32_t nowMs);
    void onScanDone(std::vector<WifiNet> nets, bool hiddenInRange, uint32_t nowMs);
    void onGotIp();
    void onDisconnected(int reason, std::string_view why, uint32_t nowMs);
    bool hasEvent() const { return !pending_.empty(); }
    std::optional<WifiEvent> poll(uint32_t nowMs);

private:
    enum class State { Idle, Scanning, Connecting, Dropping, Leaving, Up, Waiting };

    void emit(WifiEvent::Kind kind, std::string text = {}, std::vector<WifiNet> nets = {});
    void startScan();
    void connect(const WifiJoin &cred, uint32_t nowMs, std::string_view lastFailure = {});
    void connectNextSaved(uint32_t nowMs, std::string_view lastFailure = {});
    void startJoin(uint32_t nowMs);
    void failed(std::string_view why, uint32_t nowMs);
    void afterConnectAttempt();

    WifiDriver &driver_;
    std::deque<WifiEvent> pending_;
    State state_ = State::Idle;
    bool autoWanted_ = false;
    bool listWanted_ = false;
    bool scanAfterConnect_ = false;
    uint32_t deadlineMs_ = 0;
    WifiJoin target_;
    bool authRetried_ = false;
    std::string dropWhy_;
    std::string leftFailure_;
    std::optional<WifiJoin> join_;
    bool joining_ = false;
    WifiPicker picker_;
};

}
