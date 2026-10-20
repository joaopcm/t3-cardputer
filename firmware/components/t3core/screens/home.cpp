#include <algorithm>
#include <array>

#include "screens/screen.h"
#include "t3/app.h"

namespace t3 {

using namespace screen;

namespace {

enum Section { Needs, Running, Done, SectionCount };

constexpr std::array<std::string_view, SectionCount> kSectionTitles = {"NEEDS YOU", "RUNNING", "DONE TODAY"};
constexpr std::array<Color, SectionCount> kSectionColors = {Color::Warn, Color::Run, Color::Ok};
constexpr int kAgeCols = kHomeAgeCols;
constexpr int kHeadCols = Grid::Cols - kAgeCols - 1;

int sectionOf(HomeKind kind, int previous)
{
    switch (kind) {
    case HomeKind::Approval:
    case HomeKind::Question:
    case HomeKind::Failed:
        return Needs;
    case HomeKind::Running:
        return Running;
    case HomeKind::Done:
        return Done;
    case HomeKind::Unknown:
        break;
    }
    return std::max(previous, static_cast<int>(Needs));
}

char marker(HomeKind kind)
{
    switch (kind) {
    case HomeKind::Approval:
        return '!';
    case HomeKind::Question:
        return '?';
    case HomeKind::Failed:
        return 'x';
    case HomeKind::Running:
        return '*';
    case HomeKind::Done:
        return '-';
    case HomeKind::Unknown:
        break;
    }
    return '?';
}

Color rowColor(HomeKind kind)
{
    switch (kind) {
    case HomeKind::Approval:
    case HomeKind::Question:
        return Color::Warn;
    case HomeKind::Failed:
        return Color::Red;
    default:
        return Color::Text;
    }
}

std::string rowText(const HomeRow &row)
{
    std::string head = std::string(1, marker(row.kind)) + " " + row.project + " " + row.title;
    head.resize(kHeadCols, ' ');
    return head + " " + padLeft(row.age, kAgeCols);
}

}

std::vector<App::Line> App::homeLines() const
{
    std::vector<Line> lines;
    if (!home_) {
        return lines;
    }
    const Home &home = *home_;
    auto say = [&](std::string_view text, Color color) {
        for (std::string &line : wrapWords(text, Grid::Cols)) {
            lines.push_back(Line{std::move(line), color, -1});
        }
    };
    if (home.t3 == T3Status::Unreachable) {
        say("T3 unreachable", Color::Red);
    }
    if (!home.approvals.available) {
        say(home.approvals.reason.value_or("approvals down"), Color::Warn);
    }
    for (const std::string &warning : home.warnings) {
        say(warning, Color::Warn);
    }
    if (home.warningsDropped > 0) {
        say("kWarningsMax=" + std::to_string(kWarningsMax) + ", warnings needed " +
                std::to_string(home.warnings.size() + static_cast<size_t>(home.warningsDropped)),
            Color::Warn);
    }

    const std::array<int, SectionCount> counts = {home.counts.needs, home.counts.running, home.counts.done};
    int section = -1;
    auto openSectionsThrough = [&](int wanted, bool hasRow) {
        while (section < wanted) {
            ++section;
            if (counts[section] > 0 || (hasRow && section == wanted)) {
                lines.push_back(Line{std::string(kSectionTitles[section]) + " (" + std::to_string(counts[section]) + ")", kSectionColors[section], -1});
            }
        }
    };
    for (size_t i = 0; i < home.rows.size(); ++i) {
        const HomeRow &row = home.rows[i];
        openSectionsThrough(sectionOf(row.kind, section), true);
        lines.push_back(Line{rowText(row), rowColor(row.kind), static_cast<int>(i)});
    }
    openSectionsThrough(SectionCount - 1, false);

    const int total = counts[Needs] + counts[Running] + counts[Done];
    if (total > static_cast<int>(home.rows.size())) {
        say("maxHomeRows=" + std::to_string(caps_.maxHomeRows) + ", home needed " + std::to_string(total), Color::Warn);
    }
    if (home.rows.empty() && total == 0) {
        say("no threads", Color::Dim);
    }
    return lines;
}

int App::homeSelectedLine(const std::vector<Line> &lines) const
{
    for (size_t i = 0; i < lines.size(); ++i) {
        if (lines[i].row == homeSelected_) {
            return static_cast<int>(i);
        }
    }
    return -1;
}

void App::showHomeSelection()
{
    const std::vector<Line> lines = homeLines();
    const int total = static_cast<int>(lines.size());
    const int line = homeSelectedLine(lines);
    const int lastRow = home_ ? static_cast<int>(home_->rows.size()) - 1 : -1;
    if (line < 0 || homeSelected_ == 0) {
        homeTop_ = 0;
    } else if (homeSelected_ == lastRow) {
        homeTop_ = std::min(line, total - kBodyRows);
    } else {
        const bool underHeader = lines[line - 1].row < 0;
        homeTop_ = keepVisible(homeTop_, underHeader ? line - 1 : line, kBodyRows);
        homeTop_ = keepVisible(homeTop_, line, kBodyRows);
    }
    homeTop_ = clampTop(homeTop_, total, kBodyRows);
}

void App::onHome(const Home &home)
{
    std::string selected;
    if (home_ && homeSelected_ < static_cast<int>(home_->rows.size())) {
        selected = home_->rows[homeSelected_].threadId;
    }
    home_ = home;
    if (screen_ == Screen::Connecting) {
        screen_ = Screen::Home;
    }
    const auto &rows = home_->rows;
    const auto kept = std::find_if(rows.begin(), rows.end(), [&](const HomeRow &row) { return row.threadId == selected; });
    if (kept != rows.end()) {
        homeSelected_ = static_cast<int>(kept - rows.begin());
    } else {
        homeSelected_ = std::clamp(homeSelected_, 0, std::max(0, static_cast<int>(rows.size()) - 1));
    }
    showHomeSelection();
}

App::Out App::homeKey(Key key)
{
    const int count = home_ ? static_cast<int>(home_->rows.size()) : 0;
    switch (key.name) {
    case KeyName::Up:
        homeSelected_ = std::max(0, homeSelected_ - 1);
        showHomeSelection();
        return {};
    case KeyName::Down:
        homeSelected_ = std::min(std::max(0, count - 1), homeSelected_ + 1);
        showHomeSelection();
        return {};
    case KeyName::Enter:
        if (count == 0) {
            return {};
        }
        return openThread(home_->rows[homeSelected_].threadId);
    case KeyName::Char:
        if (upper(key.ch) == 'N') {
            return listProjects();
        }
        if (upper(key.ch) == 'R') {
            return refresh();
        }
        return {};
    default:
        return {};
    }
}

void App::drawHome(Grid &grid) const
{
    const std::vector<Line> lines = homeLines();
    for (int i = 0; i < kBodyRows && homeTop_ + i < static_cast<int>(lines.size()); ++i) {
        const Line &line = lines[homeTop_ + i];
        grid.put(kBodyTop + i, 0, line.text, line.color);
        if (line.row >= 0 && line.row == homeSelected_) {
            grid.selectRow(kBodyTop + i);
        }
    }
    drawHint(grid, "^v move  Enter open  N new  R refresh");
    drawBar(grid, "T3", "online");
}

}
