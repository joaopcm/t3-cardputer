#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "t3/app.h"

struct WifiEvent {
    enum class Kind { Up, Down, Scanned, Joined, JoinFailed, Status };
    Kind kind;
    std::string text;
    std::vector<t3::WifiNet> nets;
};

bool wifi_init();
void wifi_start(uint32_t nowMs);
void wifi_scan();
void wifi_join(const std::string &ssid, const std::string &password, uint32_t nowMs);
std::optional<WifiEvent> wifi_poll(uint32_t nowMs);
void wifi_debug_cut(bool blackHole);
