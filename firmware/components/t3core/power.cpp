#include "t3/power.h"

namespace t3 {

Power::Power(uint32_t dimAfterMs, uint32_t offAfterMs, uint32_t nowMs)
    : dimAfterMs_(dimAfterMs), offAfterMs_(offAfterMs), lastKeyMs_(nowMs)
{
}

Power::KeyEffect Power::onKey(uint32_t nowMs)
{
    const bool wasOff = level_ == Level::Off;
    level_ = Level::Full;
    lastKeyMs_ = nowMs;
    return wasOff ? KeyEffect::Woke : KeyEffect::Deliver;
}

bool Power::onTick(uint32_t nowMs)
{
    const uint32_t idleMs = nowMs - lastKeyMs_;
    const Level before = level_;
    if (level_ != Level::Off && idleMs >= offAfterMs_) {
        level_ = Level::Off;
    } else if (level_ == Level::Full && idleMs >= dimAfterMs_) {
        level_ = Level::Dim;
    }
    return level_ != before;
}

void Power::setTimeouts(uint32_t dimAfterMs, uint32_t offAfterMs, uint32_t nowMs)
{
    dimAfterMs_ = dimAfterMs;
    offAfterMs_ = offAfterMs;
    lastKeyMs_ = nowMs;
    level_ = Level::Full;
}

}
