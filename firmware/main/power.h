#pragma once

#include <cstdint>

#include "t3/power.h"

void power_init(uint32_t nowMs);
t3::Power::KeyEffect power_on_key(uint32_t nowMs);
void power_tick(uint32_t nowMs, bool editing);
void power_set_timeouts(uint32_t dimAfterMs, uint32_t offAfterMs, uint32_t nowMs);
t3::Power::Level power_level();
