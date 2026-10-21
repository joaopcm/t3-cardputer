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
    case Screen::SetupWifiSsid:
        return "setup_ssid";
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
    case Screen::SetupWifiSsid:
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
    const size_t held = unacked_.size() + unsent_.size();
    if (static_cast<int>(held) >= kUnackedMax) {
        inform(heldBudget("unacked_max", kUnackedMax, what, held + 1));
        return false;
    }
    return true;
}

std::string App::heldBudget(std::string budget, size_t limit, std::string_view what, size_t needed) const
{
    std::string text = budget + "=" + std::to_string(limit) + ", " + std::string(what) + " needed " + std::to_string(needed);
    if (!unsent_.empty()) {
        text += ", " + std::to_string(unsent_.size()) + " unsent wait for their threads";
    }
    return text;
}

namespace {

std::optional<std::string> encodeUnacked(const std::string &id, const std::string &threadId, const std::string &text, Mode mode,
                                         const std::optional<Request> &request, const std::optional<Option> &option)
{
    if (!request) {
        return encodeReply(id, threadId, text, mode);
    }
    std::optional<std::string_view> answer;
    if (!text.empty()) {
        answer = text;
    }
    return encodeRespond(id, threadId, request->requestId, option->value, answer);
}

size_t bytesOf(const Option &option)
{
    return option.label.size() + option.value.size();
}

size_t bytesOf(const Request &request)
{
    size_t bytes = request.threadId.size() + request.requestId.size();
    for (const std::string &line : request.lines) {
        bytes += line.size();
    }
    for (const Option &option : request.options) {
        bytes += bytesOf(option);
    }
    return bytes;
}

}

size_t App::heldBytes() const
{
    size_t bytes = 0;
    for (const Unacked &item : unacked_) {
        bytes += item.id.size() + item.threadId.size() + item.text.size() + item.confirmed.size();
        bytes += item.request ? bytesOf(*item.request) : 0;
        bytes += item.option ? bytesOf(*item.option) : 0;
    }
    for (const Unsent &item : unsent_) {
        bytes += item.threadId.size() + item.text.size() + item.requestId.value_or("").size();
        bytes += item.option ? bytesOf(*item.option) : 0;
    }
    return bytes;
}

bool App::sendTracked(Out &out, std::string_view what, Unacked item)
{
    unacked_.push_back(std::move(item));
    const size_t bytes = heldBytes();
    if (bytes > kUnackedBytesMax) {
        unacked_.pop_back();
        inform(heldBudget("unacked_bytes_max", kUnackedBytesMax, what, bytes));
        return false;
    }
    const Unacked &sent = unacked_.back();
    if (!send(out, encodeUnacked(sent.id, sent.threadId, sent.text, sent.mode, sent.request, sent.option), what)) {
        unacked_.pop_back();
        return false;
    }
    return true;
}

void App::giveBack(const Unacked &item, bool refused, std::string_view why, uint32_t nowMs)
{
    const std::string kind = item.request ? "answer" : "reply";
    const std::string here = (refused ? std::string("refused: ") : kind + " not sent: ") + std::string(why);
    if (screen_ == Screen::Thread && threadId_ == item.threadId) {
        if (item.request) {
            if (enterRequest(*item.request, nowMs)) {
                if (!item.text.empty()) {
                    typingFor_ = item.option;
                    answer_ = item.text;
                }
                inform(here);
                return;
            }
            keep(item);
            inform(here + ", Tab reopens it");
            return;
        }
        if (reply_.empty()) {
            reply_ = item.text;
            inform(here);
            return;
        }
        keep(item);
        inform(here + ", text back after this reply is sent");
        return;
    }
    const std::string elsewhere = kind + " to " + threadTitle(item.threadId) + (refused ? " failed: " : " not sent: ") + std::string(why);
    inform(keep(item) ? elsewhere + ", text back when it opens" : elsewhere);
}

bool App::keep(const Unacked &item)
{
    if (item.text.empty()) {
        return false;
    }
    std::optional<std::string> requestId;
    if (item.request) {
        requestId = item.request->requestId;
    }
    unsent_.push_back(Unsent{item.threadId, item.text, std::move(requestId), item.option});
    return true;
}

bool App::takeReply()
{
    const auto kept = std::find_if(unsent_.begin(), unsent_.end(), [&](const Unsent &item) { return item.threadId == threadId_ && !item.requestId; });
    if (!reply_.empty() || kept == unsent_.end()) {
        return false;
    }
    reply_ = std::move(kept->text);
    unsent_.erase(kept);
    return true;
}

void App::inform(std::string text, Color color)
{
    notice_ = std::move(text);
    noticeColor_ = color;
}

void App::inform(const std::vector<std::string> &notes, Color color)
{
    if (notes.empty()) {
        return;
    }
    std::string text;
    for (const std::string &note : notes) {
        text += (text.empty() ? "" : "; ") + note;
    }
    inform(std::move(text), color);
}

App::Out App::dropLink(std::vector<std::string> &notes, Color &color)
{
    std::string voiceLost;
    Out out = onVoiceLinkLost(voiceLost);
    if (!voiceLost.empty()) {
        notes.push_back(std::move(voiceLost));
        color = Color::Red;
    }
    if (!launchId_.empty()) {
        launchId_.clear();
        notes.push_back("launch result unknown, check Home");
    }
    return out;
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
    case Screen::SetupWifiSsid:
        return wifiSsidKey(key);
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
    if (!status.empty()) {
        std::vector<std::string> notes;
        Color color = Color::Warn;
        Out out = dropLink(notes, color);
        if (wasLive && unacked_.size() == 1) {
            const Unacked &item = unacked_.front();
            notes.push_back(std::string(item.request ? "answer" : "reply") + " to " + threadTitle(item.threadId) + " not confirmed, resending on reconnect");
        } else if (wasLive && unacked_.size() > 1) {
            notes.push_back(std::to_string(unacked_.size()) + " replies and answers not confirmed, resending on reconnect");
        }
        inform(notes, color);
        return out;
    }
    if (wasLive) {
        return {};
    }
    Out out;
    for (const Unacked &item : unacked_) {
        send(out, encodeUnacked(item.id, item.threadId, item.text, item.mode, item.request, item.option), item.request ? "answer" : "reply");
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

void App::onDeviceError(std::string_view why)
{
    inform(std::string(why));
}

void App::onSendFailed(std::string_view frame, std::string_view why, uint32_t nowMs)
{
    const auto tracked = std::find_if(unacked_.begin(), unacked_.end(), [&](const Unacked &item) {
        return frame.find("\"id\":\"" + item.id + "\"") != std::string_view::npos;
    });
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
    case Screen::SetupWifiSsid:
        drawWifiSsid(grid);
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
