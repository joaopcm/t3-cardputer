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
    }
    return "";
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
    notice_.clear();
    switch (screen_) {
    case Screen::Connecting:
        return key.name == KeyName::FnS ? openSetup() : Out{};
    case Screen::Home:
        return key.name == KeyName::FnS ? openSetup() : homeKey(key);
    case Screen::Thread:
        return threadKey(key);
    case Screen::Request:
        return requestKey(key, nowMs);
    case Screen::Projects:
        return projectsKey(key);
    case Screen::Prompt:
        return promptKey(key);
    case Screen::SetupWifiList:
        return wifiListKey(key);
    case Screen::SetupWifiPassword:
        return wifiPasswordKey(key);
    case Screen::SetupPair:
        return pairKey(key);
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
    } else if (const Error *error = std::get_if<Error>(&msg)) {
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
    const bool threadOpen = (screen_ == Screen::Thread || screen_ == Screen::Request) && !threadId_.empty();
    if (!status.empty() || wasLive || !threadOpen) {
        return {};
    }
    Out out;
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
    const std::string why = ack.error.value_or("no reason given");
    if (ack.id == respondId_ && responded_) {
        if (screen_ != Screen::Thread || threadId_ != responded_->threadId) {
            inform("answer to " + threadTitle(responded_->threadId) + " failed: " + why);
            return;
        }
        if (!enterRequest(*responded_, nowMs)) {
            inform("refused: " + why + ", Tab reopens it");
            return;
        }
    } else if (ack.id == replyId_) {
        if (screen_ != Screen::Thread || threadId_ != replyThreadId_ || !reply_.empty()) {
            inform("reply to " + threadTitle(replyThreadId_) + " failed: " + why);
            return;
        }
        reply_ = replySent_;
    } else if (ack.id == openId_ && screen_ == Screen::Thread) {
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
    }
}

}
