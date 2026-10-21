#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

// receipt: docs/receipts/2026-10-21-firmware-baseline.md "grid, sprite and debug serial", 2340 of 4096 used at the worst point (SHOT)
inline constexpr uint32_t kSerialTaskStackBytes = 4096;

bool serial_port_start();
std::optional<std::string> serial_port_poll_provision();
bool serial_port_poll_info();
void serial_port_reply(std::string_view line);
