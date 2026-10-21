#include "t3/wifi_pick.h"

#include <algorithm>

namespace t3 {

void WifiPicker::scanned(const std::vector<WifiNet> &nets, const std::vector<std::string> &saved, bool hiddenInRange)
{
    std::vector<WifiNet> strongest = nets;
    std::stable_sort(strongest.begin(), strongest.end(), [](const WifiNet &a, const WifiNet &b) { return a.rssi > b.rssi; });
    auto isSaved = [&](const std::string &ssid) { return std::find(saved.begin(), saved.end(), ssid) != saved.end(); };
    auto listed = [&](const std::string &ssid) {
        return std::any_of(nets.begin(), nets.end(), [&](const WifiNet &net) { return net.ssid == ssid; });
    };
    std::vector<std::string> inRange;
    for (const WifiNet &net : strongest) {
        if (isSaved(net.ssid) && std::find(inRange.begin(), inRange.end(), net.ssid) == inRange.end()) {
            inRange.push_back(net.ssid);
        }
    }
    std::vector<std::string> unlisted;
    if (hiddenInRange) {
        for (const std::string &ssid : saved) {
            if (!listed(ssid)) {
                unlisted.push_back(ssid);
            }
        }
    }
    std::vector<std::string> pool = inRange;
    pool.insert(pool.end(), unlisted.begin(), unlisted.end());
    std::sort(pool.begin(), pool.end());
    candidates_ = std::move(inRange);
    if (pool == pool_ && next()) {
        return;
    }
    pool_ = std::move(pool);
    failed_.clear();
    hidden_.reset();
    if (!unlisted.empty()) {
        hidden_ = unlisted[hiddenNext_ % unlisted.size()];
        hiddenNext_ += 1;
    }
}

std::optional<std::string> WifiPicker::next() const
{
    for (const std::string &ssid : candidates_) {
        if (!tried(ssid)) {
            return ssid;
        }
    }
    if (hidden_ && !tried(*hidden_)) {
        return hidden_;
    }
    return std::nullopt;
}

void WifiPicker::failed(std::string_view ssid)
{
    if (!tried(ssid)) {
        failed_.emplace_back(ssid);
    }
}

void WifiPicker::joined()
{
    failed_.clear();
}

bool WifiPicker::tried(std::string_view ssid) const
{
    return std::find(failed_.begin(), failed_.end(), ssid) != failed_.end();
}

}
