#include "settings.h"

#include <algorithm>
#include <cstring>
#include <variant>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "t3/relay_url.h"

namespace settings {

namespace {

constexpr char TAG[] = "settings";
constexpr char kNamespace[] = "t3";
constexpr char kWifiKey[] = "wifi";
constexpr char kTokenKey[] = "token";
constexpr char kRelayUrlKey[] = "relay_url";
constexpr char kRelayChangedKey[] = "relay_changed";
constexpr char kPairCodeKey[] = "pair_code";

struct WifiRecord {
    char ssid[kSsidMax + 1];
    char password[kPasswordMax];
};

class Handle {
public:
    explicit Handle(nvs_open_mode_t mode)
    {
        const esp_err_t err = nvs_open(kNamespace, mode, &handle_);
        open_ = err == ESP_OK;
        if (!open_ && !(err == ESP_ERR_NVS_NOT_FOUND && mode == NVS_READONLY)) {
            ESP_LOGE(TAG, "nvs_open %s failed: %s", kNamespace, esp_err_to_name(err));
            openError_ = std::string("nvs: open failed: ") + esp_err_to_name(err);
        }
    }
    ~Handle()
    {
        if (open_) {
            nvs_close(handle_);
        }
    }
    Handle(const Handle &) = delete;
    Handle &operator=(const Handle &) = delete;

    bool open() const { return open_; }
    nvs_handle_t get() const { return handle_; }

    const std::string &openError() const { return openError_; }

    std::optional<std::string> commit(const char *what, esp_err_t err)
    {
        if (err == ESP_OK) {
            err = nvs_commit(handle_);
        }
        if (err == ESP_OK) {
            return std::nullopt;
        }
        ESP_LOGE(TAG, "%s not saved: %s", what, esp_err_to_name(err));
        return std::string("nvs: ") + what + " not saved: " + esp_err_to_name(err);
    }

private:
    nvs_handle_t handle_ = 0;
    bool open_ = false;
    std::string openError_;
};

std::optional<std::string> readString(const char *key)
{
    Handle nvs(NVS_READONLY);
    if (!nvs.open()) {
        return std::nullopt;
    }
    size_t size = 0;
    if (nvs_get_str(nvs.get(), key, nullptr, &size) != ESP_OK || size <= 1) {
        return std::nullopt;
    }
    std::string value(size, '\0');
    if (nvs_get_str(nvs.get(), key, value.data(), &size) != ESP_OK) {
        return std::nullopt;
    }
    value.resize(size - 1);
    return value;
}

std::optional<std::string> writeString(const char *key, std::string_view value)
{
    Handle nvs(NVS_READWRITE);
    if (!nvs.open()) {
        return nvs.openError();
    }
    return nvs.commit(key, nvs_set_str(nvs.get(), key, std::string(value).c_str()));
}

std::optional<std::string> eraseKey(const char *key)
{
    Handle nvs(NVS_READWRITE);
    if (!nvs.open()) {
        return nvs.openError();
    }
    const esp_err_t err = nvs_erase_key(nvs.get(), key);
    return nvs.commit(key, err == ESP_ERR_NVS_NOT_FOUND ? ESP_OK : err);
}

std::string budget(const char *name, size_t limit, const char *what, size_t needed)
{
    return std::string(name) + "=" + std::to_string(limit) + ", " + what + " needed " + std::to_string(needed);
}

struct Records {
    std::vector<WifiRecord> list;
    std::optional<std::string> error;
    bool replaceable = false;
};

Records unreadable(esp_err_t err)
{
    ESP_LOGE(TAG, "saved networks unreadable: %s", esp_err_to_name(err));
    return {{}, std::string("nvs: saved networks unreadable: ") + esp_err_to_name(err)};
}

Records readRecords()
{
    Handle nvs(NVS_READONLY);
    if (!nvs.open()) {
        return {{}, nvs.openError().empty() ? std::nullopt : std::optional<std::string>(nvs.openError())};
    }
    size_t size = 0;
    if (const esp_err_t err = nvs_get_blob(nvs.get(), kWifiKey, nullptr, &size); err != ESP_OK) {
        return err == ESP_ERR_NVS_NOT_FOUND ? Records{} : unreadable(err);
    }
    if (size % sizeof(WifiRecord) != 0 || size > kMaxWifi * sizeof(WifiRecord)) {
        ESP_LOGE(TAG, "wifi blob is %u bytes, records are %u bytes and at most %u fit: ignoring it", static_cast<unsigned>(size),
                 static_cast<unsigned>(sizeof(WifiRecord)), static_cast<unsigned>(kMaxWifi));
        const std::string what = size % sizeof(WifiRecord) == 0
                                     ? budget("wifi_max", kMaxWifi, "saved networks", size / sizeof(WifiRecord))
                                     : "nvs: saved networks are " + std::to_string(size) + " bytes, not whole " + std::to_string(sizeof(WifiRecord)) + "-byte records";
        return {{}, what + ", ignored; adding a network replaces them", true};
    }
    std::vector<WifiRecord> records(size / sizeof(WifiRecord));
    if (const esp_err_t err = nvs_get_blob(nvs.get(), kWifiKey, records.data(), &size); err != ESP_OK) {
        return unreadable(err);
    }
    return {std::move(records), std::nullopt};
}

std::optional<std::string> writeRecords(const std::vector<WifiRecord> &records)
{
    Handle nvs(NVS_READWRITE);
    if (!nvs.open()) {
        return nvs.openError();
    }
    if (records.empty()) {
        const esp_err_t err = nvs_erase_key(nvs.get(), kWifiKey);
        return nvs.commit(kWifiKey, err == ESP_ERR_NVS_NOT_FOUND ? ESP_OK : err);
    }
    return nvs.commit(kWifiKey, nvs_set_blob(nvs.get(), kWifiKey, records.data(), records.size() * sizeof(WifiRecord)));
}

bool sameSsid(const WifiRecord &record, std::string_view ssid)
{
    return ssid == record.ssid;
}

}

Init init()
{
    Init result;
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "nvs unusable (%s), erasing it: wifi and token are lost", esp_err_to_name(err));
        result.erased = std::string("settings reset: nvs ") + esp_err_to_name(err) + ", wifi and token lost";
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_flash_init failed: %s", esp_err_to_name(err));
        result.error = std::string("nvs: init failed: ") + esp_err_to_name(err);
    }
    return result;
}

SavedWifi wifi()
{
    Records read = readRecords();
    SavedWifi saved{{}, std::move(read.error)};
    for (const WifiRecord &record : read.list) {
        saved.list.push_back({record.ssid, std::string(record.password, strnlen(record.password, sizeof(record.password)))});
    }
    return saved;
}

std::optional<std::string> addWifi(const WifiCred &cred)
{
    if (cred.ssid.empty() || cred.ssid.size() > kSsidMax) {
        return budget("wifi_ssid_max", kSsidMax, "ssid", cred.ssid.size());
    }
    if (cred.password.size() > kPasswordMax) {
        return budget("wifi_password_max", kPasswordMax, "password", cred.password.size());
    }
    Records read = readRecords();
    if (read.error && !read.replaceable) {
        return *read.error + ", saved networks not overwritten";
    }
    std::vector<WifiRecord> &records = read.list;
    auto at = std::find_if(records.begin(), records.end(), [&](const WifiRecord &record) { return sameSsid(record, cred.ssid); });
    if (at == records.end()) {
        if (records.size() >= kMaxWifi) {
            return budget("wifi_max", kMaxWifi, "saved networks", records.size() + 1) + ", forget one first";
        }
        records.emplace_back();
        at = records.end() - 1;
    }
    std::memset(&*at, 0, sizeof(WifiRecord));
    std::memcpy(at->ssid, cred.ssid.data(), cred.ssid.size());
    std::memcpy(at->password, cred.password.data(), cred.password.size());
    return writeRecords(records);
}

std::optional<std::string> removeWifi(std::string_view ssid)
{
    Records read = readRecords();
    if (read.error) {
        return *read.error + ", nothing forgotten";
    }
    std::vector<WifiRecord> &records = read.list;
    const auto end = std::remove_if(records.begin(), records.end(), [&](const WifiRecord &record) { return sameSsid(record, ssid); });
    if (end == records.end()) {
        return std::nullopt;
    }
    records.erase(end, records.end());
    return writeRecords(records);
}

std::optional<std::string> token()
{
    return readString(kTokenKey);
}

std::optional<std::string> setToken(std::string_view token)
{
    if (token.empty() || token.size() > kTokenMax) {
        return budget("token_max", kTokenMax, "token", token.size());
    }
    return writeString(kTokenKey, token);
}

std::optional<std::string> wipeToken()
{
    return eraseKey(kTokenKey);
}

std::optional<std::string> relayUrl()
{
    return readString(kRelayUrlKey);
}

std::optional<std::string> setRelayUrl(std::string_view url)
{
    if (url.empty()) {
        return std::string("relay url: empty");
    }
    std::variant<t3::RelayUrl, std::string> parsed = t3::parseRelayUrl(url);
    if (std::string *error = std::get_if<std::string>(&parsed)) {
        return std::move(*error);
    }
    const std::string &https = std::get<t3::RelayUrl>(parsed).https;
    const std::optional<std::string> stored = relayUrl();
    const bool wipe = t3::relayChangeWipesToken(stored ? std::optional<std::string_view>(*stored) : std::nullopt, https);
    if (std::optional<std::string> error = writeString(kRelayUrlKey, https)) {
        return error;
    }
    if (!wipe) {
        return std::nullopt;
    }
    // why: the token was issued by the old relay (docs/superpowers/plans/2026-10-21-distribution.md "Global Constraints"); the flag carries the notice across the restart that follows, and goes after the url so a failed url write never shows a false notice
    if (std::optional<std::string> error = writeString(kRelayChangedKey, "1")) {
        return error;
    }
    if (std::optional<std::string> error = wipeToken()) {
        return error;
    }
    ESP_LOGI(TAG, "relay changed: token cleared, pair again");
    return std::nullopt;
}

bool takeRelayChanged()
{
    if (!readString(kRelayChangedKey)) {
        return false;
    }
    if (const std::optional<std::string> error = eraseKey(kRelayChangedKey)) {
        ESP_LOGE(TAG, "%s", error->c_str());
    }
    return true;
}

std::optional<std::string> pendingPairCode()
{
    return readString(kPairCodeKey);
}

std::optional<std::string> setPendingPairCode(std::string_view code)
{
    return writeString(kPairCodeKey, code);
}

std::optional<std::string> clearPendingPairCode()
{
    return eraseKey(kPairCodeKey);
}

}
