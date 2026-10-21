#include <algorithm>
#include <cctype>

#include "screens/screen.h"
#include "t3/app.h"

namespace t3 {

using namespace screen;

namespace {

constexpr int kListTop = 2;
constexpr int kListRows = kBodyBottom - kListTop + 1;
constexpr int kSsidCols = 29;
constexpr int kTagCols = 5;
constexpr int kRssiCols = 4;
constexpr int kStatusRow = 6;
constexpr int kInputLabelRow = 6;
constexpr int kInputRow = 7;
constexpr int kPairStatusRow = 8;
constexpr int kPairBodyTop = 2;

// receipt: WPA/WPA2 passphrase is 8 to 63 characters (IEEE 802.11i), esp_wifi wifi_sta_config_t.password is char[64] with the NUL
constexpr size_t kWifiPasswordMin = 8;
constexpr size_t kWifiPasswordMax = 63;
// receipt: IEEE 802.11 SSID is at most 32 octets, esp_wifi wifi_sta_config_t.ssid is uint8_t[32]
constexpr size_t kWifiSsidMax = 32;
constexpr std::string_view kTypeSsidRow = "+ type a network name";
// receipt: docs/protocol.md "Pairing": code is the 8 characters as shown
constexpr size_t kPairCodeLen = 8;
constexpr std::string_view kPairName = "cardputer";

Key typed(Key key)
{
    return key.name == KeyName::TalkDown ? Key{KeyName::Char, '`'} : key;
}

std::string netLine(const WifiNet &net)
{
    std::string ssid = net.ssid.substr(0, kSsidCols);
    ssid.resize(kSsidCols, ' ');
    std::string tag = net.saved ? "saved" : net.secure ? "" : "open";
    tag.resize(kTagCols, ' ');
    return ssid + " " + tag + " " + padLeft(std::to_string(net.rssi), kRssiCols);
}

Color netColor(const WifiNet &net)
{
    return net.saved ? Color::Ok : net.secure ? Color::Text : Color::Warn;
}

std::string charCount(size_t count)
{
    return std::to_string(count) + (count == 1 ? " char" : " chars");
}

}

App::Out App::onBoot(bool hasWifi, bool hasToken)
{
    hasToken_ = hasToken;
    if (!hasWifi) {
        return openSetup();
    }
    if (!hasToken) {
        screen_ = Screen::SetupPair;
    }
    return {};
}

App::Out App::onAuthRejected()
{
    std::vector<std::string> notes;
    Color color = Color::Warn;
    Out out = dropLink(notes, color);
    if (!unacked_.empty()) {
        notes.push_back(dropUnacked());
    }
    inform(notes, color);
    hasToken_ = false;
    pairing_ = false;
    pairCode_.clear();
    pairNote_ = "re-pair needed: relay rejected token";
    screen_ = Screen::SetupPair;
    return out;
}

std::string App::dropUnacked()
{
    size_t replies = 0;
    size_t answers = 0;
    size_t kept = 0;
    for (const Unacked &item : unacked_) {
        (item.request ? answers : replies) += 1;
        kept += keep(item) ? 1 : 0;
    }
    unacked_.clear();
    std::vector<std::string> counts;
    if (replies > 0) {
        counts.push_back(std::to_string(replies) + (replies == 1 ? " reply" : " replies"));
    }
    if (answers > 0) {
        counts.push_back(std::to_string(answers) + (answers == 1 ? " answer" : " answers"));
    }
    std::string text = counts.front() + (counts.size() > 1 ? ", " + counts.back() : "") + " dropped: re-pair";
    if (kept > 0) {
        text += kept == 1 ? ", text back when its thread opens" : ", text back when their threads open";
    }
    return text;
}

App::Out App::openSetup()
{
    Out out;
    out.scanWifi = true;
    nets_.clear();
    scanned_ = false;
    netSelected_ = 0;
    netTop_ = 0;
    screen_ = Screen::SetupWifiList;
    return out;
}

void App::leaveSetup()
{
    wifiPassword_.clear();
    screen_ = home_ ? Screen::Home : Screen::Connecting;
}

void App::onWifiScan(std::vector<WifiNet> nets)
{
    nets_ = std::move(nets);
    scanned_ = true;
    netSelected_ = 0;
    netTop_ = 0;
}

App::Out App::onWifiResult(bool ok, std::string_view why)
{
    if (!joining_) {
        return {};
    }
    joining_ = false;
    if (!ok) {
        inform(why.empty() ? "wifi join failed" : std::string(why));
        return {};
    }
    wifiPassword_.clear();
    if (hasToken_) {
        leaveSetup();
        inform("wifi joined", Color::Ok);
    } else {
        screen_ = Screen::SetupPair;
    }
    return {};
}

App::Out App::onPairResult(std::optional<std::string> token, std::string_view why)
{
    if (!pairing_) {
        return {};
    }
    if (!token || token->empty()) {
        pairing_ = false;
        inform(why.empty() ? "pairing failed" : std::string(why));
        return {};
    }
    Out out;
    out.storeToken = std::move(*token);
    return out;
}

App::Out App::onTokenStored(bool ok, std::string_view why)
{
    if (!pairing_) {
        return {};
    }
    pairing_ = false;
    pairCode_.clear();
    if (!ok) {
        inform(why.empty() ? "token not saved" : std::string(why));
        return {};
    }
    Out out;
    out.reconnect = true;
    hasToken_ = true;
    pairNote_.clear();
    leaveSetup();
    inform("paired", Color::Ok);
    return out;
}

void App::onWifiForgotten(std::string_view ssid, bool ok, std::string_view why)
{
    if (!ok) {
        inform(why.empty() ? "wifi not forgotten" : std::string(why));
        return;
    }
    for (WifiNet &net : nets_) {
        if (net.ssid == ssid) {
            net.saved = false;
        }
    }
}

App::Out App::showWifiList()
{
    Out out;
    screen_ = Screen::SetupWifiList;
    out.scanWifi = !scanned_;
    return out;
}

App::Out App::wifiListKey(Key key)
{
    const int count = static_cast<int>(nets_.size());
    const bool onNet = netSelected_ < count;
    Out out;
    switch (key.name) {
    case KeyName::Up:
        netSelected_ = std::max(0, netSelected_ - 1);
        break;
    case KeyName::Down:
        netSelected_ = std::min(count, netSelected_ + 1);
        break;
    case KeyName::Enter:
        if (onNet) {
            joinTarget_ = nets_[netSelected_];
            wifiPassword_.clear();
            screen_ = Screen::SetupWifiPassword;
        } else {
            typedSsid_.clear();
            screen_ = Screen::SetupWifiSsid;
        }
        return out;
    case KeyName::Tab:
        screen_ = Screen::SetupPair;
        return out;
    case KeyName::Esc:
    case KeyName::Backspace:
        leaveSetup();
        return out;
    case KeyName::Char:
        if (upper(key.ch) == 'R') {
            nets_.clear();
            scanned_ = false;
            netSelected_ = 0;
            netTop_ = 0;
            out.scanWifi = true;
        } else if (upper(key.ch) == 'D' && onNet && nets_[netSelected_].saved) {
            out.forgetWifi = nets_[netSelected_].ssid;
        }
        return out;
    default:
        return out;
    }
    netTop_ = keepVisible(netTop_, netSelected_, kListRows - (nets_.empty() ? 1 : 0));
    return out;
}

App::Out App::wifiSsidKey(Key key)
{
    key = typed(key);
    switch (key.name) {
    case KeyName::Char:
        type(typedSsid_, key.ch, static_cast<int>(kWifiSsidMax), "wifi_ssid_max", "ssid");
        break;
    case KeyName::Backspace:
        if (typedSsid_.empty()) {
            return showWifiList();
        }
        typedSsid_.pop_back();
        break;
    case KeyName::Esc:
        return showWifiList();
    case KeyName::Enter:
        if (typedSsid_.empty()) {
            inform("type a network name first", Color::Warn);
            break;
        }
        joinTarget_ = WifiNet{typedSsid_, 0, true, false};
        wifiPassword_.clear();
        screen_ = Screen::SetupWifiPassword;
        break;
    default:
        break;
    }
    return {};
}

App::Out App::wifiPasswordKey(Key key)
{
    Out out;
    key = typed(key);
    switch (key.name) {
    case KeyName::Char:
        if (joinTarget_.secure) {
            type(wifiPassword_, key.ch, static_cast<int>(kWifiPasswordMax), "wifi_password_max", "password");
        }
        break;
    case KeyName::Backspace:
        if (wifiPassword_.empty()) {
            return showWifiList();
        }
        wifiPassword_.pop_back();
        break;
    case KeyName::Esc:
        return showWifiList();
    case KeyName::Enter:
        if (joining_) {
            inform("joining...", Color::Ok);
        } else if (joinTarget_.secure && wifiPassword_.size() < kWifiPasswordMin) {
            inform("wifi_password_min=" + std::to_string(kWifiPasswordMin) + ", password has " + std::to_string(wifiPassword_.size()), Color::Warn);
        } else {
            joining_ = true;
            out.joinWifi = WifiJoin{joinTarget_.ssid, wifiPassword_};
        }
        break;
    default:
        break;
    }
    return out;
}

App::Out App::pairKey(Key key)
{
    Out out;
    key = typed(key);
    switch (key.name) {
    case KeyName::Char:
        if (std::isalnum(static_cast<unsigned char>(key.ch))) {
            type(pairCode_, upper(key.ch), static_cast<int>(kPairCodeLen), "pair_code_len", "code");
        } else {
            inform("code is letters and digits only", Color::Warn);
        }
        break;
    case KeyName::Backspace:
        if (pairCode_.empty()) {
            return showWifiList();
        }
        pairCode_.pop_back();
        break;
    case KeyName::Esc:
        return showWifiList();
    case KeyName::Enter:
        if (pairing_) {
            inform("pairing...", Color::Ok);
        } else if (pairCode_.size() != kPairCodeLen) {
            inform("pair_code_len=" + std::to_string(kPairCodeLen) + ", code has " + std::to_string(pairCode_.size()), Color::Warn);
        } else {
            pairing_ = true;
            out.pair = PairRequest{pairCode_, std::string(kPairName)};
        }
        break;
    default:
        break;
    }
    return out;
}

void App::drawSetupBar(Grid &grid, std::string_view step) const
{
    if (!notice_.empty()) {
        drawBar(grid, "setup", step);
        return;
    }
    grid.put(0, 0, "setup");
    grid.put(0, Grid::Cols - static_cast<int>(step.size()), step);
}

void App::drawWifiList(Grid &grid) const
{
    grid.put(1, 0, "pick a network", Color::Dim);
    int top = kListTop;
    if (!scanned_) {
        grid.put(top++, 0, "scanning...", Color::Dim);
    } else if (nets_.empty()) {
        grid.put(top++, 0, "no networks found, R scans again", Color::Warn);
    }
    const int count = static_cast<int>(nets_.size());
    for (int i = 0; top + i <= kBodyBottom && netTop_ + i <= count; ++i) {
        const int index = netTop_ + i;
        if (index < count) {
            grid.put(top + i, 0, netLine(nets_[index]), netColor(nets_[index]));
        } else {
            grid.put(top + i, 0, kTypeSsidRow, Color::Dim);
        }
        if (index == netSelected_) {
            grid.selectRow(top + i);
        }
    }
    drawHint(grid, "Enter join  R scan  D forget  Tab pair");
    drawSetupBar(grid, "wifi 1/3");
}

void App::drawWifiSsid(Grid &grid) const
{
    grid.put(1, 0, "type the network name", Color::Dim);
    grid.put(3, 0, inputLine(typedSsid_));
    grid.put(4, 0, std::to_string(typedSsid_.size()) + "/" + std::to_string(kWifiSsidMax), Color::Dim);
    drawHint(grid, "Enter next  Esc back");
    drawSetupBar(grid, "wifi 1/3");
}

void App::drawWifiPassword(Grid &grid) const
{
    grid.put(1, 0, joinTarget_.ssid, Color::Hdr);
    if (joinTarget_.secure) {
        grid.put(2, 0, "password", Color::Dim);
        grid.put(3, 0, inputLine(std::string(wifiPassword_.size(), '*')));
        grid.put(4, 0, charCount(wifiPassword_.size()), Color::Dim);
    } else {
        grid.put(2, 0, "open network, no password needed", Color::Dim);
    }
    if (joining_) {
        grid.put(kStatusRow, 0, "joining...", Color::Ok);
    }
    drawHint(grid, "Enter join  Esc back");
    drawSetupBar(grid, "wifi 2/3");
}

void App::drawPair(Grid &grid) const
{
    grid.put(1, 0, "pair with the relay", Color::Dim);
    std::vector<Line> lines;
    if (!pairNote_.empty()) {
        lines.push_back(Line{pairNote_, Color::Warn, -1});
    }
    for (std::string &line : wrapWords("run t3-cardputer-relay pair on the relay host and type the code", Grid::Cols)) {
        lines.push_back(Line{std::move(line), Color::Text, -1});
    }
    for (size_t i = 0; i < lines.size(); ++i) {
        grid.put(kPairBodyTop + static_cast<int>(i), 0, lines[i].text, lines[i].color);
    }
    grid.put(kInputLabelRow, 0, "code " + std::to_string(pairCode_.size()) + "/" + std::to_string(kPairCodeLen), Color::Dim);
    grid.put(kInputRow, 0, inputLine(pairCode_));
    if (pairing_) {
        grid.put(kPairStatusRow, 0, "pairing...", Color::Ok);
    }
    drawHint(grid, "Enter pair  Esc back");
    drawSetupBar(grid, "pair 3/3");
}

}
