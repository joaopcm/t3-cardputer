#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace settings {

struct WifiCred {
    std::string ssid;
    std::string password;
};

// receipt: docs/receipts/2026-10-21-nvs-settings.md
inline constexpr size_t kMaxWifi = 8;
// receipt: IEEE 802.11 SSID is at most 32 octets, WPA passphrase at most 63 characters
inline constexpr size_t kSsidMax = 32;
inline constexpr size_t kPasswordMax = 63;
// receipt: docs/protocol.md hello.token is 1-256 chars
inline constexpr size_t kTokenMax = 256;

std::optional<std::string> init();

std::vector<WifiCred> wifi();
std::optional<std::string> addWifi(const WifiCred &cred);
std::optional<std::string> removeWifi(std::string_view ssid);

std::optional<std::string> token();
std::optional<std::string> setToken(std::string_view token);
std::optional<std::string> wipeToken();

std::string relayUrl();
std::optional<std::string> setRelayUrl(std::string_view url);

}
