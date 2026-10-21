#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "t3/app.h"

namespace t3 {

class WifiPicker {
public:
    void scanned(const std::vector<WifiNet> &nets, const std::vector<std::string> &saved, bool hiddenInRange);
    std::optional<std::string> next() const;
    void failed(std::string_view ssid);
    void joined();

private:
    bool tried(std::string_view ssid) const;

    std::vector<std::string> pool_;
    std::vector<std::string> candidates_;
    std::optional<std::string> hidden_;
    std::string lastHidden_;
    std::vector<std::string> failed_;
};

}
