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
// receipt: IEEE 802.11 SSID is at most 32 octets; WPA passphrase at most 63 characters or a raw PSK of 64 hex digits, which fills esp_wifi's password[64] with no NUL
inline constexpr size_t kSsidMax = 32;
inline constexpr size_t kPasswordMax = 64;
// receipt: docs/protocol.md hello.token is 1-256 chars
inline constexpr size_t kTokenMax = 256;

struct Init {
    std::optional<std::string> error;
    std::optional<std::string> erased;
};

Init init();

struct SavedWifi {
    std::vector<WifiCred> list;
    std::optional<std::string> error;
};

SavedWifi wifi();
std::optional<std::string> addWifi(const WifiCred &cred);
std::optional<std::string> removeWifi(std::string_view ssid);

std::optional<std::string> token();
std::optional<std::string> setToken(std::string_view token);
std::optional<std::string> wipeToken();

std::optional<std::string> relayUrl();
std::optional<std::string> setRelayUrl(std::string_view url);
bool takeRelayChanged();

std::optional<std::string> pendingPairCode();
std::optional<std::string> setPendingPairCode(std::string_view code);
std::optional<std::string> clearPendingPairCode();

}
