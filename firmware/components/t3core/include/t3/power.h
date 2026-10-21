#pragma once

#include <cstdint>

#include "t3/keys.h"

namespace t3 {

class Power {
public:
    enum class Level { Full, Dim, Off };
    enum class KeyEffect { Deliver, Woke, WokeAndDeliver };

    Power(uint32_t dimAfterMs, uint32_t offAfterMs, uint32_t nowMs);

    KeyEffect onKey(KeyName key, uint32_t nowMs);
    bool onTick(uint32_t nowMs);
    void setEditing(bool editing) { editing_ = editing; }
    void setRecording(bool recording) { recording_ = recording; }
    void setTimeouts(uint32_t dimAfterMs, uint32_t offAfterMs, uint32_t nowMs);

    Level level() const { return level_; }

private:
    uint32_t dimAfterMs_;
    uint32_t offAfterMs_;
    uint32_t lastKeyMs_;
    bool editing_ = false;
    bool recording_ = false;
    Level level_ = Level::Full;
};

}
