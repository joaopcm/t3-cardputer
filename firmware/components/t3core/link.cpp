#include "t3/link.h"

#include <algorithm>
#include <utility>

namespace t3 {

Link::Link(const HelloCaps &caps, std::string token, std::string fw) : caps_(caps), token_(std::move(token)), fw_(std::move(fw)) {}

void Link::setToken(std::string token)
{
    token_ = std::move(token);
}

Link::Out Link::connectNow()
{
    state_ = State::Connecting;
    Out out;
    out.statusText = "connecting";
    out.connect = true;
    return out;
}

Link::Out Link::retryAfter(std::string statusText)
{
    state_ = State::Backoff;
    const uint32_t delay = backoffMs_;
    backoffMs_ = std::min(backoffMs_ * 2, kBackoffMaxMs);
    retryAtMs_ = nowMs_ + delay;
    Out out;
    out.statusText = std::move(statusText);
    out.reconnectInMs = delay;
    return out;
}

Link::Out Link::onWifi(bool up)
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
    return connectNow();
}

Link::Out Link::onOpen()
{
    Out out;
    if (state_ != State::Connecting) {
        out.closeSocket = true;
        return out;
    }
    lastError_.clear();
    const std::optional<std::string> hello = encodeHello(caps_, token_, fw_);
    if (!hello) {
        Out failed = retryAfter("heap: hello needed more than available");
        failed.closeSocket = true;
        return failed;
    }
    state_ = State::Hello;
    out.send.push_back(*hello);
    return out;
}

Link::Out Link::onPreWelcome(std::string_view frame)
{
    std::string err;
    const std::optional<RelayMsg> msg = parseRelay(frame, caps_, err);
    if (!msg) {
        Out failed = retryAfter(err);
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
        return Out{};
    }
    Out failed = retryAfter("relay sent a frame before welcome");
    failed.closeSocket = true;
    return failed;
}

Link::Out Link::onText(std::string_view frame)
{
    if (state_ == State::Hello) {
        return onPreWelcome(frame);
    }
    Out out;
    out.passToApp = state_ == State::Live;
    return out;
}

Link::Out Link::onClose(int code, std::string_view lastError)
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
    return retryAfter("relay unreachable: " + reason);
}

Link::Out Link::onTick(uint32_t nowMs)
{
    nowMs_ = nowMs;
    if (state_ == State::Backoff && static_cast<int32_t>(nowMs - retryAtMs_) >= 0) {
        return connectNow();
    }
    return Out{};
}

Link::Out Link::onUserReconnect()
{
    if (state_ != State::Stopped && state_ != State::NeedsPair) {
        return Out{};
    }
    backoffMs_ = kBackoffMinMs;
    if (!wifiUp_) {
        state_ = State::NoWifi;
        Out out;
        out.statusText = "wifi down";
        return out;
    }
    return connectNow();
}

}
