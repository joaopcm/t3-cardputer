#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <variant>

#include "t3/relay_url.h"

namespace t3 {

// receipt: JSON.stringify escapes only quotes, backslashes and control chars, so even an all-\u00XX ssid and password are (32 + 64) x 6 = 576 bytes; + 320 relay + 8 code + about 70 of keys, quotes and "T3PROV " = 974; 1024 is the tripwire
inline constexpr size_t kProvisionLineMax = 1024;

struct ProvisionWifi {
    std::string ssid;
    std::string password;
};

struct ProvisionRequest {
    std::optional<ProvisionWifi> wifi;
    std::optional<RelayUrl> relay;
    std::optional<std::string> code;
};

std::variant<ProvisionRequest, std::string> parseProvision(std::string_view json);

struct DeviceInfo {
    std::string fw;
    bool relaySet;
    bool paired;
    int wifiSaved;
};

std::string encodeInfo(const DeviceInfo &info);

}
