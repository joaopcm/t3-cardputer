#include <algorithm>

#include "screens/screen.h"
#include "t3/app.h"

namespace t3 {

using namespace screen;

namespace {

constexpr int kHeaderRow = 1;
constexpr int kLinesTop = 2;

Color statusColor(std::string_view status)
{
    if (status == "running" || status == "starting" || status == "preparing" || status == "queued") {
        return Color::Run;
    }
    if (status == "done" || status == "completed") {
        return Color::Ok;
    }
    if (status == "failed" || status == "interrupted" || status == "cancelled") {
        return Color::Red;
    }
    return Color::Text;
}

}

App::Out App::openThread(std::string threadId)
{
    Out out;
    const std::string id = nextId();
    if (!send(out, encodeOpenThread(id, threadId), "open_thread")) {
        return out;
    }
    openId_ = id;
    if (threadId != threadId_) {
        page_.reset();
        reply_.clear();
        waiting_.reset();
    }
    threadId_ = std::move(threadId);
    request_.reset();
    screen_ = Screen::Thread;
    return out;
}

App::Out App::threadKey(Key key)
{
    Out out;
    const bool loaded = page_ && page_->threadId == threadId_;
    auto turnTo = [&](int page) {
        send(out, encodePage(nextId(), threadId_, page), "page");
    };
    auto sendReply = [&](Mode mode) {
        if (reply_.empty() || !readyToSend("reply")) {
            return;
        }
        const std::string id = nextId();
        Unacked item{id, {}, threadId_, reply_, "reply sent: " + std::string(modeName(mode)), std::nullopt, std::nullopt};
        if (sendTracked(out, encodeReply(id, threadId_, reply_, mode), "reply", std::move(item))) {
            reply_.clear();
        }
    };
    switch (key.name) {
    case KeyName::Up:
        if (loaded && page_->page > 1) {
            turnTo(page_->page - 1);
        }
        break;
    case KeyName::Down:
        if (loaded && page_->page < page_->pages) {
            turnTo(page_->page + 1);
        }
        break;
    case KeyName::Enter:
        sendReply(Mode::Queue);
        break;
    case KeyName::FnEnter:
        sendReply(Mode::Steer);
        break;
    case KeyName::Backspace:
        if (reply_.empty()) {
            screen_ = Screen::Home;
        } else {
            reply_.pop_back();
        }
        break;
    case KeyName::Esc:
        screen_ = Screen::Home;
        break;
    case KeyName::Tab:
        return showWaiting();
    case KeyName::Char:
        type(reply_, key.ch, kReplyTextMax, "reply_text_max", "reply");
        break;
    default:
        break;
    }
    return out;
}

void App::drawThread(Grid &grid) const
{
    const HomeRow *row = homeRow(threadId_);
    const bool loaded = page_ && page_->threadId == threadId_;
    int lineCount = 0;
    if (loaded) {
        const ThreadPage &page = *page_;
        const std::string position = std::to_string(page.page) + "/" + std::to_string(page.pages);
        if (page.truncated) {
            const std::string budget = page.truncated->budget + "=" + std::to_string(page.truncated->limit) + ", reply needed " +
                                       std::to_string(page.truncated->actual);
            grid.put(kHeaderRow, 0, budget, Color::Warn);
            if (budget.size() + 1 + position.size() <= static_cast<size_t>(Grid::Cols)) {
                grid.put(kHeaderRow, Grid::Cols - static_cast<int>(position.size()), position, Color::Dim);
            }
        } else {
            std::string header = page.header.model;
            if (row) {
                header += " - " + row->age + " ago";
            }
            grid.put(kHeaderRow, 0, header + " - " + position, Color::Dim);
        }
        lineCount = std::min(static_cast<int>(page.lines.size()), kBodyBottom - kLinesTop + 1);
        for (int i = 0; i < lineCount; ++i) {
            grid.put(kLinesTop + i, 0, page.lines[i]);
        }
    } else {
        grid.put(kHeaderRow, 0, "loading", Color::Dim);
    }

    const int inputRow = std::min(kBodyBottom, kLinesTop + lineCount + 1);
    if (!reply_.empty() || kLinesTop + lineCount <= inputRow) {
        grid.put(inputRow, 0, std::string(Grid::Cols, ' '));
        grid.put(inputRow, 0, inputLine(reply_));
        grid.selectRow(inputRow);
    }
    if (waiting_) {
        drawHint(grid, reply_.empty() ? "Tab request  type to reply  Bksp back" : "Tab request  Enter queue  Fn+Enter steer");
    } else {
        drawHint(grid, reply_.empty() ? "type or hold ` talk  ^v page  Bksp back" : "Enter queue  Fn+Enter steer");
    }

    if (loaded) {
        drawBar(grid, page_->header.project + " - " + page_->header.title, page_->header.status, statusColor(page_->header.status));
    } else if (row) {
        drawBar(grid, row->project + " - " + row->title, "");
    } else {
        drawBar(grid, threadId_, "");
    }
}

}
