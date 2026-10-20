#include <algorithm>

#include "screens/screen.h"
#include "t3/app.h"

namespace t3 {

using namespace screen;

namespace {

constexpr std::string_view kTypeValues[] = {"deny_with_reason", "text"};

bool asksForText(const Option &option)
{
    return std::find(std::begin(kTypeValues), std::end(kTypeValues), option.value) != std::end(kTypeValues);
}

Color optionColor(const Request &request, const Option &option, bool approvalsDown)
{
    if (request.kind != RequestKind::Approval) {
        return Color::Text;
    }
    if (approvalsDown || option.value == "deny_with_reason") {
        return Color::Dim;
    }
    if (option.value == "allow_once") {
        return Color::Ok;
    }
    if (option.value == "deny") {
        return Color::Red;
    }
    return Color::Text;
}

std::string keyList(const std::vector<Option> &options)
{
    std::string digits;
    std::string others;
    for (const Option &option : options) {
        (option.key >= '1' && option.key <= '9' ? digits : others).push_back(option.key);
    }
    std::vector<std::string> groups;
    if (digits.size() > 2 && digits == std::string("123456789").substr(0, digits.size())) {
        groups.push_back(std::string("1-") + digits.back());
    } else {
        for (char key : digits) {
            groups.emplace_back(1, key);
        }
    }
    for (char key : others) {
        groups.emplace_back(1, key);
    }
    std::string text;
    for (const std::string &group : groups) {
        text += (text.empty() ? "" : "/") + group;
    }
    return text;
}

}

App::RequestLayout App::requestLayout() const
{
    RequestLayout layout;
    const Request &request = *request_;
    const bool approvalsDown = request.kind == RequestKind::Approval && home_ && !home_->approvals.available;
    std::vector<Line> options;
    for (size_t i = 0; i < request.options.size(); ++i) {
        const Option &option = request.options[i];
        options.push_back(Line{"[" + std::string(1, option.key) + "] " + option.label, optionColor(request, option, approvalsDown), static_cast<int>(i)});
    }
    for (size_t i = 0; i < request.lines.size(); ++i) {
        layout.scroll.push_back(Line{request.lines[i], i == 0 ? Color::Hdr : Color::Text, -1});
    }
    const int rows = kBodyRows - (typingFor_ ? 1 : 0);
    const int optionRows = static_cast<int>(options.size());
    if (optionRows < rows) {
        layout.pinned = std::move(options);
        layout.scrollRows = rows - optionRows;
    } else {
        layout.scroll.insert(layout.scroll.end(), options.begin(), options.end());
        layout.scrollRows = rows;
    }
    return layout;
}

void App::onRequest(const Request &request, uint32_t nowMs)
{
    if (request.threadId != threadId_ || (screen_ != Screen::Thread && screen_ != Screen::Request)) {
        inform("request waiting: " + (request.lines.empty() ? request.requestId : request.lines.front()), Color::Warn);
        return;
    }
    const bool alreadyShown = screen_ == Screen::Request && request_ && request_->requestId == request.requestId && request_->lines == request.lines;
    if (alreadyShown) {
        request_ = request;
        return;
    }
    if (!enterRequest(request, nowMs)) {
        inform("request waiting: Tab opens it", Color::Warn);
    }
}

bool App::enterRequest(const Request &request, uint32_t nowMs)
{
    const bool typing = (screen_ == Screen::Thread && !reply_.empty()) || (screen_ == Screen::Request && typingFor_);
    if (typing) {
        waiting_ = request;
        return false;
    }
    showRequest(request);
    guardSinceMs_ = nowMs;
    return true;
}

void App::showRequest(const Request &request)
{
    if (waiting_ && waiting_->requestId == request.requestId) {
        waiting_.reset();
    }
    request_ = request;
    requestTop_ = 0;
    answer_.clear();
    typingFor_.reset();
    if (request.options.empty()) {
        typingFor_ = Option{'T', "Type answer", "text"};
    }
    screen_ = Screen::Request;
}

App::Out App::showWaiting()
{
    if (waiting_) {
        const Request request = *waiting_;
        showRequest(request);
        guardSinceMs_.reset();
    }
    return {};
}

App::Out App::respond(Option option, std::optional<std::string> text)
{
    Out out;
    const Request &request = *request_;
    const std::string id = nextId();
    std::optional<std::string_view> textView;
    if (text) {
        textView = *text;
    }
    if (!send(out, encodeRespond(id, request.threadId, request.requestId, option.value, textView), "respond")) {
        return out;
    }
    respondId_ = id;
    responded_ = request_;
    if (waiting_ && waiting_->requestId == request.requestId) {
        waiting_.reset();
    }
    typingFor_.reset();
    answer_.clear();
    screen_ = Screen::Thread;
    inform("sent: " + option.label, Color::Ok);
    return out;
}

App::Out App::requestKey(Key key, uint32_t nowMs)
{
    const bool typed = key.name == KeyName::Char || key.name == KeyName::Enter || key.name == KeyName::FnEnter;
    if (guardSinceMs_ && static_cast<int32_t>(nowMs - *guardSinceMs_) < static_cast<int32_t>(kRequestGuardMs)) {
        if (typed) {
            guardSinceMs_ = nowMs;
            inform("request just arrived, press again", Color::Warn);
            return {};
        }
    } else {
        guardSinceMs_.reset();
    }
    if (key.name == KeyName::Tab && waiting_) {
        return showWaiting();
    }
    const Request &request = *request_;
    const RequestLayout layout = requestLayout();
    const int maxTop = std::max(0, static_cast<int>(layout.scroll.size()) - layout.scrollRows);
    requestTop_ = std::min(requestTop_, maxTop);
    if (key.name == KeyName::Up) {
        requestTop_ = std::max(0, requestTop_ - 1);
        return {};
    }
    if (key.name == KeyName::Down) {
        requestTop_ = std::min(maxTop, requestTop_ + 1);
        return {};
    }

    if (typingFor_) {
        const bool onlyText = request.options.empty();
        switch (key.name) {
        case KeyName::Enter:
            if (answer_.empty()) {
                inform("type an answer first", Color::Warn);
                return {};
            }
            return respond(*typingFor_, answer_);
        case KeyName::Backspace:
            if (!answer_.empty()) {
                answer_.pop_back();
                return {};
            }
            [[fallthrough]];
        case KeyName::Esc:
            answer_.clear();
            if (onlyText) {
                screen_ = Screen::Home;
            } else {
                typingFor_.reset();
            }
            return {};
        case KeyName::Char:
            type(answer_, key.ch, kRespondTextMax, "respond_text_max", "answer");
            return {};
        default:
            return {};
        }
    }

    switch (key.name) {
    case KeyName::Enter:
        screen_ = Screen::Thread;
        return {};
    case KeyName::Backspace:
    case KeyName::Esc:
        screen_ = Screen::Home;
        return {};
    case KeyName::Char:
        break;
    default:
        return {};
    }
    const auto option = std::find_if(request.options.begin(), request.options.end(), [&](const Option &o) { return upper(o.key) == upper(key.ch); });
    if (option == request.options.end()) {
        return upper(key.ch) == 'R' ? refresh() : Out{};
    }
    if (request.kind == RequestKind::Approval && home_ && !home_->approvals.available) {
        inform(home_->approvals.reason.value_or("approvals down"), Color::Warn);
        return {};
    }
    if (asksForText(*option)) {
        typingFor_ = *option;
        answer_.clear();
        return {};
    }
    return respond(*option, std::nullopt);
}

void App::drawRequest(Grid &grid) const
{
    const Request &request = *request_;
    const RequestLayout layout = requestLayout();
    const int total = static_cast<int>(layout.scroll.size());
    const int top = clampTop(requestTop_, total, layout.scrollRows);
    auto put = [&](int row, const Line &line) {
        grid.put(row, 0, line.text, line.color);
        if (typingFor_ && line.row >= 0 && request.options[line.row].key == typingFor_->key) {
            grid.selectRow(row);
        }
    };
    for (int i = 0; i < layout.scrollRows && top + i < total; ++i) {
        put(kBodyTop + i, layout.scroll[top + i]);
    }
    for (size_t i = 0; i < layout.pinned.size(); ++i) {
        put(kBodyTop + layout.scrollRows + static_cast<int>(i), layout.pinned[i]);
    }

    const bool scrollable = total > layout.scrollRows;
    if (typingFor_) {
        grid.put(kBodyBottom, 0, inputLine(answer_));
        grid.selectRow(kBodyBottom);
        drawHint(grid, waiting_ ? "Tab request  Enter send  Bksp back" : scrollable ? "Enter send  ^v more  Bksp back" : "Enter send  Bksp back");
    } else {
        drawHint(grid, keyList(request.options) + (scrollable ? "  ^v more  Enter thread" : "  Enter thread  Bksp back"));
    }

    const HomeRow *row = homeRow(request.threadId);
    const bool paged = page_ && page_->threadId == request.threadId;
    std::string left = row ? row->project : paged ? page_->header.project : std::string(screenName());
    if (paged && !page_->header.model.empty()) {
        left += " - " + page_->header.model;
    }
    drawBar(grid, left, row ? row->age : "");
}

}
