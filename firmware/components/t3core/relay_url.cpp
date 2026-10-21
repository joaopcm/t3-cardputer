#include "t3/relay_url.h"

#include <algorithm>
#include <cctype>

namespace t3 {

namespace {

constexpr unsigned long kPortMax = 65535;

std::string lowered(std::string_view text)
{
    std::string out(text);
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

bool dnsChar(char c)
{
    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-';
}

bool allDigits(std::string_view text)
{
    return !text.empty() && std::all_of(text.begin(), text.end(), [](unsigned char c) { return std::isdigit(c) != 0; });
}

}

std::variant<RelayUrl, std::string> parseRelayUrl(std::string_view text)
{
    if (text.size() > kRelayUrlMax) {
        return "relay_url_max=" + std::to_string(kRelayUrlMax) + ", url needed " + std::to_string(text.size());
    }
    std::string rest = lowered(text);
    if (const size_t scheme = rest.find("://"); scheme != std::string::npos) {
        const std::string_view name = std::string_view(rest).substr(0, scheme);
        if (name != "https" && name != "wss") {
            return std::string("relay url must be https:// or wss://");
        }
        rest.erase(0, scheme + 3);
    }
    if (!rest.empty() && rest.back() == '/') {
        rest.pop_back();
    }
    if (rest.find_first_of("/?#@") != std::string::npos) {
        return std::string("relay url: host and port only, no path");
    }
    const size_t colon = rest.rfind(':');
    const std::string host = rest.substr(0, colon);
    if (host.empty()) {
        return std::string("relay url: no host");
    }
    if (!std::all_of(host.begin(), host.end(), dnsChar) || (host.find('.') == std::string::npos && host != "localhost")) {
        return "relay url: host " + host + " is not a dns name";
    }
    std::string authority = host;
    if (colon != std::string::npos) {
        const std::string port = rest.substr(colon + 1);
        if (!allDigits(port)) {
            return "relay url: port " + port + " is not a number";
        }
        const unsigned long number = port.size() > 5 ? kPortMax + 1 : std::stoul(port);
        if (number == 0 || number > kPortMax) {
            return "relay url: port " + port + " out of range";
        }
        authority += ":" + std::to_string(number);
    }
    return RelayUrl{"https://" + authority, "wss://" + authority};
}

}
