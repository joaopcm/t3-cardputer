#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <variant>

namespace t3 {

struct RelayUrl {
    std::string https;
    std::string wss;
};

// receipt: a DNS name is at most 253 chars (RFC 1035 2.3.4) + "https://" 8 + ":65535" 6 = 267, 320 is the tripwire
inline constexpr size_t kRelayUrlMax = 320;

std::variant<RelayUrl, std::string> parseRelayUrl(std::string_view text);
bool relayChangeWipesToken(std::optional<std::string_view> stored, std::string_view next);

}
