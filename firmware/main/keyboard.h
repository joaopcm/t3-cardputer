#pragma once

#include <optional>

#include "driver/i2c_master.h"

#include "t3/keys.h"

bool keyboard_init();
std::optional<t3::Key> keyboard_poll();
i2c_master_bus_handle_t system_i2c_bus();
