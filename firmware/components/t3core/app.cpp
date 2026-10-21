#include "t3/app.h"

#include <algorithm>
#include <utility>

#include "screens/screen.h"

namespace t3 {

using namespace screen;

std::vector<std::string> wrapWords(std::string_view text, int width)
{
    const size_t cols = static_cast<size_t>(std::max(1, width));
    std::vector<std::string> lines;
    size_t pos = 0;
    while (text.size() - pos > cols) {
        const size_t space = text.rfind(' ', pos + cols);
        if (space == std::string_view::npos || space <= pos) {
            lines.emplace_back(text.substr(pos, cols));
            pos += cols;
        } else {
            lines.emplace_back(text.substr(pos, space - pos));
            pos = space + 1;
        }
    }
    lines.emplace_back(text.substr(pos));
    return lines;
}

App::App(const HelloCaps &caps, uint64_t idSeed) : caps_(caps), ids_(idSeed) {}

std::string_view App::screenName() const
{
    switch (screen_) {
    case Screen::Connecting:
        return "connecting";
    case Screen::Home:
        return "home";
    case Screen::Thread:
        return "thread";
    case Screen::Request:
        return request_ && request_->kind == RequestKind::Question ? "question" : "approval";
    case Screen::Projects:
        return "projects";
    case Screen::Prompt:
        return "new_task";
    case Screen::SetupWifiList:
        return "setup_wifi";
    case Screen::SetupWifiPassword:
        return "setup_password";
    case Screen::SetupPair:
        return "setup_pair";
    case Screen::Voice:
        return "voice";
    }
    return "";
}

bool App::editing() const
{
    switch (screen_) {
    case Screen::SetupWifiList:
    case Screen::SetupWifiPassword:
    case Screen::SetupPair:
    case Screen::Voice:
        return true;
    case Screen::Thread:
        return !reply_.empty();
    case Screen::Request:
        return typingFor_.has_value();
    case Screen::Prompt:
        return !prompt_.empty();
    case Screen::Connecting:
    case Screen::Home:
    case Screen::Projects:
        return false;
    }
    return false;
}

bool App::send(Out &out, std::optional<std::string> frame, std::string_view what)
{
    if (!frame) {
        inform("out of memory: " + std::string(what) + " not sent");
        return false;
    }
    out.send.push_back(std::move(*frame));
    return true;
}

bool App::readyToSend(std::string_view what)
{
    if (!linkStatus_.empty()) {
        inform(std::string(what) + " not sent: " + linkStatus_);
        return false;
    }
    if (static_cast<int>(unacked_.size()) >= kUnackedMax) {
        inform("unacked_max=" + std::to_string(kUnackedMax) + ", " + std::string(what) + " needed " + std::to_string(unacked_.size() + 1));
        return false;
    }
    return true;
}

bool App::sendTracked(Out &out, std::optional<std::string> frame, std::string_view what, Unacked item)
{
    if (!send(out, std::move(frame), what)) {
        return false;
    }
    item.frame = out.send.back();
    unacked_.push_back(std::move(item));
    return true;
}

void App::giveBack(const Unacked &item, bool refused, std::string_view why, uint32_t nowMs)
{
    const std::string kind = item.request ? "answer" : "reply";
    const std::string elsewhere = kind + " to " + threadTitle(item.threadId) + (refused ? " failed: " : " not sent: ") + std::string(why);
    const std::string here = (refused ? std::string("refused: ") : kind + " not sent: ") + std::string(why);
    if (screen_ != Screen::Thread || threadId_ != item.threadId) {
        inform(elsewhere);
        return;
    }
    if (item.request) {
        if (!enterRequest(*item.request, nowMs)) {
            inform(here + ", Tab reopens it");
            return;
        }
        if (!item.text.empty()) {
            typingFor_ = item.option;
            answer_ = item.text;
        }
    } else {
        if (!reply_.empty()) {
            inform(elsewhere);
            return;
        }
        reply_ = item.text;
    }
    inform(here);
}

void App::inform(std::string text, Color color)
{
    notice_ = std::move(text);
    noticeColor_ = color;
}

void App::type(std::string &text, char c, int max, std::string_view budget, std::string_view what)
{
    if (static_cast<int>(text.size()) >= max) {
        inform(std::string(budget) + "=" + std::to_string(max) + ", " + std::string(what) + " needed " + std::to_string(text.size() + 1));
        return;
    }
    text.push_back(c);
}

App::Out App::refresh()
{
    Out out;
    send(out, encodeRefresh(nextId()), "refresh");
    return out;
}

App::Out App::onWake()
{
    if (!linkStatus_.empty()) {
        return {};
    }
    return refresh();
}

std::string App::health() const
{
    if (!home_) {
        return {};
    }
    if (home_->t3 == T3Status::Unreachable) {
        return "T3 unreachable";
    }
    if (!home_->approvals.available) {
        return "approvals down";
    }
    const size_t warnings = home_->warnings.size() + static_cast<size_t>(home_->warningsDropped);
    if (warnings == 1) {
        return "1 warning";
    }
    if (warnings > 1) {
        return std::to_string(warnings) + " warnings";
    }
    return {};
}

const HomeRow *App::homeRow(std::string_view threadId) const
{
    if (!home_) {
        return nullptr;
    }
    for (const HomeRow &row : home_->rows) {
        if (row.threadId == threadId) {
            return &row;
        }
    }
    return nullptr;
}

void App::drawBar(Grid &grid, std::string_view left, std::string_view right, Color rightColor) const
{
    const std::string &alert = notice_.empty() ? linkStatus_ : notice_;
    if (!alert.empty()) {
        const Color color = notice_.empty() ? Color::Warn : noticeColor_;
        const std::vector<std::string> lines = wrapWords(alert, Grid::Cols);
        for (int row = 0; row < static_cast<int>(lines.size()) && row < kHintRow; ++row) {
            grid.put(row, 0, std::string(Grid::Cols, ' '));
            grid.put(row, 0, lines[row], color);
        }
        return;
    }
    const std::string tag = health();
    const std::string_view shown = tag.empty() ? right : tag;
    const int leftCols = Grid::Cols - static_cast<int>(shown.size()) - (shown.empty() ? 0 : 1);
    grid.put(0, 0, left.substr(0, static_cast<size_t>(std::max(0, leftCols))));
    grid.put(0, Grid::Cols - static_cast<int>(shown.size()), shown, tag.empty() ? rightColor : Color::Warn);
}

void App::drawHint(Grid &grid, std::string_view hint)
{
    grid.put(kHintRow, 0, hint, Color::Dim);
}

App::Out App::onKey(Key key, uint32_t nowMs)
{
    if (key.name != KeyName::TalkUp) {
        notice_.clear();
    }
    const bool talk = key.name == KeyName::TalkDown;
    switch (screen_) {
    case Screen::Connecting:
        return key.name == KeyName::FnS ? openSetup() : Out{};
    case Screen::Home:
        return key.name == KeyName::FnS ? openSetup() : homeKey(key);
    case Screen::Thread:
        return talk ? startVoice(nowMs) : threadKey(key);
    case Screen::Request:
        return requestKey(key, nowMs);
    case Screen::Projects:
        return projectsKey(key);
    case Screen::Prompt:
        return talk ? startVoice(nowMs) : promptKey(key);
    case Screen::SetupWifiList:
        return wifiListKey(key);
    case Screen::SetupWifiPassword:
        return wifiPasswordKey(key);
    case Screen::SetupPair:
        return pairKey(key);
    case Screen::Voice:
        return voiceKey(key, nowMs);
    }
    return {};
}

App::Out App::onFrame(std::string_view json, uint32_t nowMs)
{
    std::string err;
    const std::optional<RelayMsg> msg = parseRelay(json, caps_, err);
    if (!msg) {
        inform(err);
        return {};
    }
    return onRelay(*msg, nowMs);
}

App::Out App::onRelay(const RelayMsg &msg, uint32_t nowMs)
{
    if (const Ack *ack = std::get_if<Ack>(&msg)) {
        if (!ack->id.empty() && (ack->id == audioStartId_ || ack->id == audioEndId_)) {
            return onAudioAck(*ack);
        }
        onAck(*ack, nowMs);
    } else if (const Home *home = std::get_if<Home>(&msg)) {
        onHome(*home);
    } else if (const ThreadPage *page = std::get_if<ThreadPage>(&msg)) {
        if (page->threadId == threadId_) {
            page_ = *page;
        }
    } else if (const Request *request = std::get_if<Request>(&msg)) {
        onRequest(*request, nowMs);
    } else if (const Projects *projects = std::get_if<Projects>(&msg); projects && screen_ == Screen::Projects) {
        projects_ = *projects;
        projectSelected_ = 0;
        projectTop_ = 0;
    } else if (const TranscriptPartial *partial = std::get_if<TranscriptPartial>(&msg)) {
        if (screen_ == Screen::Voice && voice_ != Voice::Review) {
            voicePartial_ = partial->text;
        }
    } else if (const TranscriptFinal *final = std::get_if<TranscriptFinal>(&msg)) {
        onTranscript(final->text);
    } else if (const Error *error = std::get_if<Error>(&msg)) {
        if (std::optional<Out> out = onAudioError(*error)) {
            return *out;
        }
        inform(error->message.empty() ? "relay error" : error->message);
    }
    return {};
}

App::Out App::onLinkStatus(std::string_view status)
{
    const bool wasLive = linkStatus_.empty();
    linkStatus_ = std::string(status);
    if (!status.empty() && !launchId_.empty()) {
        launchId_.clear();
        inform("launch result unknown, check Home", Color::Warn);
    }
    if (!status.empty()) {
        if (wasLive && unacked_.size() == 1) {
            const Unacked &item = unacked_.front();
            inform(std::string(item.request ? "answer" : "reply") + " to " + threadTitle(item.threadId) + " not confirmed, resending on reconnect", Color::Warn);
        } else if (wasLive && unacked_.size() > 1) {
            inform(std::to_string(unacked_.size()) + " replies and answers not confirmed, resending on reconnect", Color::Warn);
        }
        return onVoiceLinkLost();
    }
    if (wasLive) {
        return {};
    }
    Out out;
    for (const Unacked &item : unacked_) {
        out.send.push_back(item.frame);
    }
    const bool voiceOnThread = screen_ == Screen::Voice && voiceFrom_ == Screen::Thread;
    const bool threadOpen = (screen_ == Screen::Thread || screen_ == Screen::Request || voiceOnThread) && !threadId_.empty();
    if (!threadOpen) {
        return out;
    }
    const std::string id = nextId();
    if (send(out, encodeOpenThread(id, threadId_), "open_thread")) {
        openId_ = id;
    }
    return out;
}

void App::onTransportError(std::string_view why)
{
    inform(std::string(why));
}

void App::onSendFailed(std::string_view frame, std::string_view why, uint32_t nowMs)
{
    const auto tracked = std::find_if(unacked_.begin(), unacked_.end(), [&](const Unacked &item) { return item.frame == frame; });
    if (tracked == unacked_.end()) {
        inform(std::string(why));
        return;
    }
    const Unacked item = std::move(*tracked);
    unacked_.erase(tracked);
    giveBack(item, false, why, nowMs);
}

std::string App::threadTitle(std::string_view threadId) const
{
    if (page_ && page_->threadId == threadId) {
        return page_->header.title;
    }
    if (const HomeRow *row = homeRow(threadId)) {
        return row->title;
    }
    return std::string(threadId);
}

void App::onAck(const Ack &ack, uint32_t nowMs)
{
    const bool launch = !launchId_.empty() && ack.id == launchId_;
    if (launch) {
        launchId_.clear();
    }
    const std::string why = ack.error.value_or("no reason given");
    const auto tracked = std::find_if(unacked_.begin(), unacked_.end(), [&](const Unacked &item) { return item.id == ack.id; });
    if (tracked != unacked_.end()) {
        const Unacked item = std::move(*tracked);
        unacked_.erase(tracked);
        if (ack.ok) {
            inform(item.confirmed, Color::Ok);
        } else {
            giveBack(item, true, why, nowMs);
        }
        return;
    }
    if (ack.ok) {
        if (launch) {
            prompt_.clear();
            if (screen_ == Screen::Prompt) {
                screen_ = Screen::Home;
            }
            inform("task launched", Color::Ok);
        }
        return;
    }
    if (ack.id == openId_ && screen_ == Screen::Thread) {
        screen_ = Screen::Home;
    }
    inform("refused: " + why);
}

void App::draw(Grid &grid) const
{
    grid.clear();
    switch (screen_) {
    case Screen::Connecting:
        if (linkStatus_.empty()) {
            grid.put(2, 0, "waiting for home", Color::Dim);
        }
        drawBar(grid, "T3", "");
        return;
    case Screen::Home:
        drawHome(grid);
        return;
    case Screen::Thread:
        drawThread(grid);
        return;
    case Screen::Request:
        drawRequest(grid);
        return;
    case Screen::Projects:
        drawProjects(grid);
        return;
    case Screen::Prompt:
        drawPrompt(grid);
        return;
    case Screen::SetupWifiList:
        drawWifiList(grid);
        return;
    case Screen::SetupWifiPassword:
        drawWifiPassword(grid);
        return;
    case Screen::SetupPair:
        drawPair(grid);
        return;
    case Screen::Voice:
        drawVoice(grid);
        return;
    }
}

}
