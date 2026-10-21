#include "t3/provision.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <memory>

#include "cJSON.h"
#include "json_hooks.h"
#include "t3/protocol.h"

namespace t3 {

namespace {

// receipt: IEEE 802.11 SSID is at most 32 octets
constexpr size_t kSsidMax = 32;
// receipt: IEEE 802.11i, a WPA passphrase is 8 to 63 characters and a raw PSK is 64 hex digits
constexpr size_t kPassphraseMin = 8;
constexpr size_t kPassphraseMax = 63;
constexpr size_t kPskHexChars = 64;
// receipt: docs/protocol.md "Pairing": code is the 8 characters as shown
constexpr size_t kPairCodeChars = 8;

struct JsonDeleter {
    void operator()(cJSON *json) const { cJSON_Delete(json); }
};
using JsonPtr = std::unique_ptr<cJSON, JsonDeleter>;

std::string_view trimmed(std::string_view text)
{
    const auto space = [](unsigned char c) { return std::isspace(c) != 0; };
    while (!text.empty() && space(text.front())) {
        text.remove_prefix(1);
    }
    while (!text.empty() && space(text.back())) {
        text.remove_suffix(1);
    }
    return text;
}

bool startsWithNoCase(std::string_view text, std::string_view prefix)
{
    return text.size() >= prefix.size() && std::equal(prefix.begin(), prefix.end(), text.begin(), [](char a, char b) {
               return std::toupper(static_cast<unsigned char>(a)) == std::toupper(static_cast<unsigned char>(b));
           });
}

bool allHex(std::string_view text)
{
    return std::all_of(text.begin(), text.end(), [](unsigned char c) { return std::isxdigit(c) != 0; });
}

std::optional<std::string> wifiError(const ProvisionWifi &wifi)
{
    if (wifi.ssid.empty()) {
        return std::string("wifi ssid: empty");
    }
    if (wifi.ssid.size() > kSsidMax) {
        return "wifi_ssid_max=" + std::to_string(kSsidMax) + ", ssid needed " + std::to_string(wifi.ssid.size());
    }
    const size_t length = wifi.password.size();
    if (length == kPskHexChars) {
        return allHex(wifi.password) ? std::nullopt : std::optional<std::string>("wifi password: 64 chars is a raw psk and must be hex digits");
    }
    if (length != 0 && (length < kPassphraseMin || length > kPassphraseMax)) {
        return "wifi password: " + std::to_string(kPassphraseMin) + "-" + std::to_string(kPassphraseMax) +
               " chars or empty for an open network, got " + std::to_string(length);
    }
    return std::nullopt;
}

std::string upperTrimmed(std::string_view text)
{
    std::string out(trimmed(text));
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return out;
}

std::optional<std::string> pairCodeError(std::string_view code)
{
    const bool letterOrDigit = std::all_of(code.begin(), code.end(), [](char c) { return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'); });
    if (code.size() == kPairCodeChars && letterOrDigit) {
        return std::nullopt;
    }
    return "pair code: " + std::to_string(kPairCodeChars) + " letters or digits, got " + std::to_string(code.size());
}

std::optional<std::string> stringField(const cJSON *item, const std::string &name, std::string &out)
{
    if (!cJSON_IsString(item)) {
        return "provision: " + name + " must be a string";
    }
    out = item->valuestring;
    return std::nullopt;
}

std::optional<std::string> parseWifi(const cJSON *item, ProvisionWifi &wifi)
{
    if (!cJSON_IsObject(item)) {
        return std::string("provision: wifi must be an object");
    }
    for (const cJSON *field = item->child; field != nullptr; field = field->next) {
        const std::string_view key = field->string;
        if (key != "ssid" && key != "password") {
            return "provision: unknown key 'wifi." + std::string(key) + "'";
        }
    }
    if (std::optional<std::string> error = stringField(cJSON_GetObjectItemCaseSensitive(item, "ssid"), "wifi.ssid", wifi.ssid)) {
        return error;
    }
    if (std::optional<std::string> error = stringField(cJSON_GetObjectItemCaseSensitive(item, "password"), "wifi.password", wifi.password)) {
        return error;
    }
    return wifiError(wifi);
}

std::optional<std::string> parseField(const cJSON *item, ProvisionRequest &request)
{
    const std::string_view key = item->string;
    std::string text;
    if (key == "wifi") {
        ProvisionWifi wifi;
        if (std::optional<std::string> error = parseWifi(item, wifi)) {
            return error;
        }
        request.wifi = std::move(wifi);
        return std::nullopt;
    }
    if (key == "relay") {
        if (std::optional<std::string> error = stringField(item, "relay", text)) {
            return error;
        }
        std::variant<RelayUrl, std::string> relay = parseRelayUrl(trimmed(text));
        if (std::string *error = std::get_if<std::string>(&relay)) {
            return std::move(*error);
        }
        request.relay = std::get<RelayUrl>(std::move(relay));
        return std::nullopt;
    }
    if (key == "code") {
        if (std::optional<std::string> error = stringField(item, "code", text)) {
            return error;
        }
        std::string code = upperTrimmed(text);
        if (std::optional<std::string> error = pairCodeError(code)) {
            return error;
        }
        request.code = std::move(code);
        return std::nullopt;
    }
    return "provision: unknown key '" + std::string(key) + "'";
}

void appendEscaped(std::string &out, std::string_view text)
{
    for (const char c : text) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += c;
        } else if (static_cast<unsigned char>(c) < 0x20) {
            char escaped[7];
            std::snprintf(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned>(c));
            out += escaped;
        } else {
            out += c;
        }
    }
}

}

std::variant<ProvisionRequest, std::string> parseProvision(std::string_view json)
{
    installJsonHooks();
    const char *parseEnd = nullptr;
    const JsonPtr root(cJSON_ParseWithLengthOpts(json.data(), json.size(), &parseEnd, false));
    if (!root) {
        if (const int depth = jsonNestingDepth(json); depth > kJsonNestingMax) {
            return "json_nesting_max=" + std::to_string(kJsonNestingMax) + ", frame needed " + std::to_string(depth);
        }
        return "provision: not valid json at byte " + std::to_string(parseEnd == nullptr ? 0 : parseEnd - json.data());
    }
    if (!cJSON_IsObject(root.get())) {
        return std::string("provision: expected a json object");
    }
    if (root->child == nullptr) {
        return std::string("provision: nothing to set");
    }
    ProvisionRequest request;
    for (const cJSON *item = root->child; item != nullptr; item = item->next) {
        if (std::optional<std::string> error = parseField(item, request)) {
            return std::move(*error);
        }
    }
    return request;
}

std::string encodeInfo(const DeviceInfo &info)
{
    std::string out = "{\"fw\":\"";
    appendEscaped(out, info.fw);
    out += "\",\"protocol\":" + std::to_string(ProtocolVersion);
    out += std::string(",\"relaySet\":") + (info.relaySet ? "true" : "false");
    out += std::string(",\"paired\":") + (info.paired ? "true" : "false");
    out += ",\"wifiSaved\":" + std::to_string(info.wifiSaved) + "}";
    return out;
}

SerialLine classifySerialLine(std::string_view line)
{
    constexpr std::string_view kProvision = "T3PROV";
    constexpr std::string_view kProvisionFrame = "T3PROV ";
    constexpr std::string_view kInfo = "T3INFO";
    if (line.substr(0, kProvisionFrame.size()) == kProvisionFrame) {
        return SerialLine::Provision;
    }
    if (line == kInfo) {
        return SerialLine::Info;
    }
    if (startsWithNoCase(line, kProvision) || startsWithNoCase(line, kInfo)) {
        return SerialLine::Misframed;
    }
    return SerialLine::Other;
}

std::string printableLine(std::string_view line)
{
    std::string out(line);
    std::replace_if(out.begin(), out.end(), [](unsigned char c) { return c < 0x20 || c == 0x7f; }, '?');
    return out;
}

}
