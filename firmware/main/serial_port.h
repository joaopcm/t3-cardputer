#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include "sdkconfig.h"

// receipt: docs/receipts/2026-10-21-firmware-baseline.md, debug 2340 of 4096 used at SHOT, release 2376 of 4096 after an err reply; kept at 4096 in both: 1.7x the release worst, and another size changes the boot allocations the reconnect heap was soaked with (2026-10-21-firmware-voice.md "heap")
inline constexpr uint32_t kSerialTaskStackBytes = 4096;

bool serial_port_start();
std::optional<std::string> serial_port_poll_provision();
bool serial_port_poll_info();
void serial_port_reply(std::string_view line);

#ifdef CONFIG_T3_DEBUG_SERIAL
void serial_port_hand_over_debug_line(size_t len);
std::optional<std::string> serial_port_poll_debug_line(size_t prefixBytes);
#endif
