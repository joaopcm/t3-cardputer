#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include "t3/wifi_station.h"

using WifiEvent = t3::WifiEvent;

bool wifi_init();
void wifi_start(uint32_t nowMs);
void wifi_scan();
void wifi_join(const std::string &ssid, const std::string &password, uint32_t nowMs);
std::optional<WifiEvent> wifi_poll(uint32_t nowMs);
void wifi_debug_leave_ap();
void wifi_debug_black_hole(bool on);
