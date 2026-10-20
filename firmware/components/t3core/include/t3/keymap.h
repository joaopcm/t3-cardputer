#pragma once

#include <cstdint>
#include <optional>

#include "t3/keys.h"

namespace t3 {

class KeyDecoder {
public:
    std::optional<Key> onEvent(uint8_t code, bool pressed);

private:
    bool fn_ = false;
    bool shift_ = false;
    bool talking_ = false;
};

}
