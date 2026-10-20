#pragma once

#include <optional>

#include "t3/keys.h"

bool keyboard_init();
std::optional<t3::Key> keyboard_poll();
