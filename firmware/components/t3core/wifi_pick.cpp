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
    std::vector<std::string> candidates;
    for (const WifiNet &net : strongest) {
        if (isSaved(net.ssid) && std::find(candidates.begin(), candidates.end(), net.ssid) == candidates.end()) {
            candidates.push_back(net.ssid);
        }
    }
    if (hiddenInRange) {
        for (const std::string &ssid : saved) {
            if (!listed(ssid)) {
                candidates.push_back(ssid);
            }
        }
    }
    std::vector<std::string> before = candidates_;
    std::vector<std::string> after = candidates;
    std::sort(before.begin(), before.end());
    std::sort(after.begin(), after.end());
    candidates_ = std::move(candidates);
    if (before != after || !next()) {
        failed_.clear();
    }
}

std::optional<std::string> WifiPicker::next() const
{
    for (const std::string &ssid : candidates_) {
        if (!tried(ssid)) {
            return ssid;
        }
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
