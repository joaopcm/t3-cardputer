#include "t3/wifi_station.h"

#include <algorithm>

namespace t3 {

namespace {

bool reached(uint32_t nowMs, uint32_t atMs)
{
    return static_cast<int32_t>(nowMs - atMs) >= 0;
}

}

void WifiStation::emit(WifiEvent::Kind kind, std::string text, std::vector<WifiNet> nets)
{
    pending_.push_back(WifiEvent{kind, std::move(text), std::move(nets)});
}

void WifiStation::startScan()
{
    if (state_ == State::Connecting || state_ == State::Dropping || state_ == State::Leaving) {
        scanAfterConnect_ = true;
        return;
    }
    if (state_ == State::Scanning) {
        return;
    }
    if (const std::optional<std::string> error = driver_.startScan()) {
        emit(WifiEvent::Kind::Status, "wifi: scan failed: " + *error);
        if (listWanted_) {
            listWanted_ = false;
            emit(WifiEvent::Kind::Scanned);
        }
        return;
    }
    if (state_ != State::Up) {
        state_ = State::Scanning;
    }
}

void WifiStation::connect(const WifiJoin &cred, uint32_t nowMs, std::string_view lastFailure)
{
    target_ = cred;
    if (const std::optional<std::string> error = driver_.connect(cred)) {
        failed("join did not start: " + *error, nowMs);
        return;
    }
    state_ = State::Connecting;
    deadlineMs_ = nowMs + kWifiJoinWaitMs;
    emit(WifiEvent::Kind::Status, (lastFailure.empty() ? std::string("wifi: ") : std::string(lastFailure) + ", ") + "joining " + cred.ssid);
}

void WifiStation::connectNextSaved(uint32_t nowMs, std::string_view lastFailure)
{
    const SavedWifi saved = driver_.saved();
    if (const std::optional<std::string> ssid = picker_.next()) {
        for (const WifiJoin &cred : saved.creds) {
            if (cred.ssid == *ssid) {
                authRetried_ = false;
                connect(cred, nowMs, lastFailure);
                return;
            }
        }
    }
    state_ = State::Waiting;
    deadlineMs_ = nowMs + kWifiRetryMs;
    if (!lastFailure.empty()) {
        emit(WifiEvent::Kind::Status, std::string(lastFailure));
    } else if (saved.error) {
        emit(WifiEvent::Kind::Status, "wifi: " + *saved.error);
    } else {
        emit(WifiEvent::Kind::Status, saved.creds.empty() ? "wifi: no saved network, Fn+S adds one" : "wifi: no saved network in range");
    }
}

void WifiStation::startJoin(uint32_t nowMs)
{
    const WifiJoin cred = *join_;
    join_.reset();
    joining_ = true;
    authRetried_ = false;
    connect(cred, nowMs);
}

void WifiStation::failed(std::string_view why, uint32_t nowMs)
{
    state_ = State::Waiting;
    const std::string failure = "wifi: " + target_.ssid + " failed, " + std::string(why);
    if (joining_) {
        joining_ = false;
        deadlineMs_ = nowMs;
        emit(WifiEvent::Kind::JoinFailed, failure);
        return;
    }
    picker_.failed(target_.ssid);
    connectNextSaved(nowMs, failure);
}

void WifiStation::afterConnectAttempt()
{
    if (scanAfterConnect_) {
        scanAfterConnect_ = false;
        startScan();
    }
}

void WifiStation::start(uint32_t nowMs)
{
    autoWanted_ = true;
    if (state_ == State::Idle || state_ == State::Waiting) {
        deadlineMs_ = nowMs;
        state_ = State::Waiting;
    }
}

void WifiStation::scan()
{
    listWanted_ = true;
    startScan();
}

void WifiStation::join(WifiJoin cred, uint32_t nowMs)
{
    autoWanted_ = true;
    const std::string ssid = cred.ssid;
    join_ = std::move(cred);
    switch (state_) {
    case State::Up:
        emit(WifiEvent::Kind::Down, "joining " + ssid);
        [[fallthrough]];
    case State::Connecting:
        state_ = State::Leaving;
        deadlineMs_ = nowMs + kWifiJoinWaitMs;
        driver_.disconnect();
        return;
    case State::Dropping:
        picker_.failed(target_.ssid);
        state_ = State::Leaving;
        deadlineMs_ = nowMs + kWifiJoinWaitMs;
        return;
    case State::Scanning:
    case State::Leaving:
        return;
    case State::Idle:
    case State::Waiting:
        startJoin(nowMs);
        return;
    }
}

void WifiStation::onScanDone(std::vector<WifiNet> nets, bool hiddenInRange, uint32_t nowMs)
{
    const SavedWifi saved = driver_.saved();
    std::vector<std::string> savedSsids;
    for (const WifiJoin &cred : saved.creds) {
        savedSsids.push_back(cred.ssid);
    }
    for (WifiNet &net : nets) {
        net.saved = std::find(savedSsids.begin(), savedSsids.end(), net.ssid) != savedSsids.end();
    }
    const bool searching = state_ == State::Scanning;
    if (searching) {
        state_ = State::Idle;
    }
    if (listWanted_) {
        listWanted_ = false;
        emit(WifiEvent::Kind::Scanned, {}, nets);
    }
    if (state_ == State::Idle && join_) {
        startJoin(nowMs);
    } else if (searching && autoWanted_) {
        picker_.scanned(nets, savedSsids, hiddenInRange);
        connectNextSaved(nowMs);
    }
}

void WifiStation::onGotIp()
{
    if (state_ != State::Connecting) {
        return;
    }
    state_ = State::Up;
    picker_.joined();
    if (joining_) {
        joining_ = false;
        emit(WifiEvent::Kind::Joined, target_.ssid);
    }
    emit(WifiEvent::Kind::Up, target_.ssid);
    afterConnectAttempt();
}

void WifiStation::onDisconnected(int reason, std::string_view why, uint32_t nowMs)
{
    switch (state_) {
    case State::Leaving:
        state_ = State::Idle;
        startJoin(nowMs);
        return;
    case State::Connecting:
        if (reason == kWifiReasonAuthExpire && !authRetried_) {
            // why: after a sudden reset the access point still holds the old association and answers the first join with reason 2; the device check of 2026-10-21 at a4f6842 saw it on 2 of 3 reboots after a typed join, and the next join went through
            const WifiJoin cred = target_;
            authRetried_ = true;
            connect(cred, nowMs, "wifi: " + cred.ssid + " auth expired (reason 2)");
            return;
        }
        failed(why, nowMs);
        afterConnectAttempt();
        return;
    case State::Dropping:
        failed(dropWhy_, nowMs);
        afterConnectAttempt();
        return;
    case State::Up:
        emit(WifiEvent::Kind::Down, std::string(why));
        state_ = State::Idle;
        if (autoWanted_) {
            startScan();
        }
        return;
    case State::Idle:
    case State::Scanning:
    case State::Waiting:
        return;
    }
}

std::optional<WifiEvent> WifiStation::poll(uint32_t nowMs)
{
    if (pending_.empty()) {
        if (state_ == State::Connecting && reached(nowMs, deadlineMs_)) {
            // why: the driver answers this disconnect with STA_DISCONNECTED (reason 8, ASSOC_LEAVE); joining the next network before it lands would charge that event to the next network
            driver_.disconnect();
            dropWhy_ = "no ip within kWifiJoinWaitMs=" + std::to_string(kWifiJoinWaitMs);
            state_ = State::Dropping;
            deadlineMs_ = nowMs + kWifiJoinWaitMs;
        } else if (state_ == State::Dropping && reached(nowMs, deadlineMs_)) {
            failed(dropWhy_, nowMs);
            afterConnectAttempt();
        } else if (state_ == State::Leaving && reached(nowMs, deadlineMs_)) {
            state_ = State::Idle;
            startJoin(nowMs);
        } else if (state_ == State::Waiting && autoWanted_ && reached(nowMs, deadlineMs_)) {
            state_ = State::Idle;
            startScan();
        }
    }
    if (pending_.empty()) {
        return std::nullopt;
    }
    WifiEvent event = std::move(pending_.front());
    pending_.pop_front();
    return event;
}

}
