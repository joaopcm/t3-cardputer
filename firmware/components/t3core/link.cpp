#include "t3/link.h"

#include <algorithm>
#include <utility>

namespace t3 {

namespace {

bool reached(uint32_t nowMs, uint32_t deadlineMs)
{
    return static_cast<int32_t>(nowMs - deadlineMs) >= 0;
}

}

Link::Link(const HelloCaps &caps, std::string token, std::string fw) : caps_(caps), token_(std::move(token)), fw_(std::move(fw)) {}

void Link::setToken(std::string token)
{
    token_ = std::move(token);
}

Link::Out Link::connectNow(uint32_t nowMs)
{
    Out out;
    if (token_.empty()) {
        state_ = State::NeedsPair;
        out.statusText = "re-pair needed";
        return out;
    }
    state_ = State::Connecting;
    deadlineMs_ = nowMs + kConnectWaitMs;
    out.statusText = "connecting";
    out.connect = true;
    return out;
}

Link::Out Link::retryAfter(std::string statusText, uint32_t nowMs)
{
    state_ = State::Backoff;
    const uint32_t delay = backoffMs_;
    backoffMs_ = std::min(backoffMs_ * 2, kBackoffMaxMs);
    deadlineMs_ = nowMs + delay;
    Out out;
    out.statusText = std::move(statusText);
    out.reconnectInMs = delay;
    return out;
}

Link::Out Link::onWifi(bool up, uint32_t nowMs)
{
    wifiUp_ = up;
    Out out;
    if (!up) {
        if (state_ == State::NeedsPair || state_ == State::Stopped) {
            return out;
        }
        state_ = State::NoWifi;
        out.statusText = "wifi down";
        out.closeSocket = true;
        return out;
    }
    if (state_ != State::NoWifi) {
        return out;
    }
    backoffMs_ = kBackoffMinMs;
    return connectNow(nowMs);
}

Link::Out Link::onOpen(uint32_t nowMs)
{
    Out out;
    if (state_ != State::Connecting) {
        out.closeSocket = true;
        return out;
    }
    lastError_.clear();
    const std::optional<std::string> hello = encodeHello(caps_, token_, fw_);
    if (!hello) {
        Out failed = retryAfter("heap: hello needed more than available", nowMs);
        failed.closeSocket = true;
        return failed;
    }
    state_ = State::Hello;
    deadlineMs_ = nowMs + kHelloWaitMs;
    out.send.push_back(*hello);
    return out;
}

Link::Out Link::onPreWelcome(std::string_view frame, uint32_t nowMs)
{
    std::string err;
    const std::optional<RelayMsg> msg = parseRelay(frame, caps_, err);
    if (!msg) {
        Out failed = retryAfter(err, nowMs);
        failed.closeSocket = true;
        return failed;
    }
    if (const Error *error = std::get_if<Error>(&*msg)) {
        lastError_ = error->message;
        Out out;
        out.statusText = error->message;
        return out;
    }
    if (std::holds_alternative<Welcome>(*msg)) {
        state_ = State::Live;
        backoffMs_ = kBackoffMinMs;
        Out out;
        out.statusText = "";
        return out;
    }
    Out failed = retryAfter("relay sent a frame before welcome", nowMs);
    failed.closeSocket = true;
    return failed;
}

Link::Out Link::onText(std::string_view frame, uint32_t nowMs)
{
    if (state_ == State::Hello) {
        return onPreWelcome(frame, nowMs);
    }
    Out out;
    out.passToApp = state_ == State::Live;
    return out;
}

Link::Out Link::onClose(int code, std::string_view lastError, uint32_t nowMs)
{
    if (state_ == State::NoWifi || state_ == State::Stopped || state_ == State::NeedsPair || state_ == State::Backoff) {
        return Out{};
    }
    const std::string message = lastError.empty() ? lastError_ : std::string(lastError);
    lastError_.clear();
    switch (closeAction(code, message)) {
    case CloseAction::RePair: {
        state_ = State::NeedsPair;
        token_.clear();
        Out out;
        out.wipeToken = true;
        out.statusText = "re-pair needed";
        return out;
    }
    case CloseAction::UpdateFirmware:
    case CloseAction::UpdateRelay: {
        state_ = State::Stopped;
        Out out;
        out.statusText = message;
        return out;
    }
    case CloseAction::ShowAndStop: {
        state_ = State::Stopped;
        Out out;
        if (code == 4000) {
            out.statusText = "replaced by another connection";
        } else {
            out.statusText = message.empty() ? "closed " + std::to_string(code) : message;
        }
        return out;
    }
    case CloseAction::Reconnect:
        break;
    }
    const std::string reason = message.empty() ? "closed " + std::to_string(code) : message;
    return retryAfter("relay unreachable: " + reason, nowMs);
}

Link::Out Link::onTick(uint32_t nowMs)
{
    if (!reached(nowMs, deadlineMs_)) {
        return Out{};
    }
    switch (state_) {
    case State::Backoff:
        return connectNow(nowMs);
    case State::Connecting: {
        Out out = retryAfter("relay unreachable: no connection within kConnectWaitMs=" + std::to_string(kConnectWaitMs), nowMs);
        out.closeSocket = true;
        return out;
    }
    case State::Hello: {
        Out out = retryAfter("relay unreachable: no welcome within kHelloWaitMs=" + std::to_string(kHelloWaitMs), nowMs);
        out.closeSocket = true;
        return out;
    }
    default:
        return Out{};
    }
}

std::optional<std::string> Link::pairRefused() const
{
    constexpr std::string_view kAfterRePair = "pair if the relay asks to re-pair";
    switch (state_) {
    case State::NeedsPair:
    case State::Stopped:
        return std::nullopt;
    case State::NoWifi:
        return "pairing refused: wifi down, join a network first";
    case State::Connecting:
    case State::Hello:
        return "pairing refused: connecting with the saved token, " + std::string(kAfterRePair);
    case State::Live:
        return "pairing refused: already paired and connected, " + std::string(kAfterRePair);
    case State::Backoff:
        return "pairing refused: relay unreachable, retrying with the saved token; " + std::string(kAfterRePair);
    }
    return std::nullopt;
}

Link::Out Link::onUserReconnect(uint32_t nowMs)
{
    if (state_ != State::Stopped && state_ != State::NeedsPair) {
        return Out{};
    }
    if (token_.empty()) {
        Out out;
        out.statusText = "re-pair needed";
        return out;
    }
    backoffMs_ = kBackoffMinMs;
    if (!wifiUp_) {
        state_ = State::NoWifi;
        Out out;
        out.statusText = "wifi down";
        return out;
    }
    return connectNow(nowMs);
}

}
