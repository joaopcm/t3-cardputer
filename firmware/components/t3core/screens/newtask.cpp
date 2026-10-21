#include <algorithm>
#include <array>

#include "screens/screen.h"
#include "t3/app.h"

namespace t3 {

using namespace screen;

namespace {

constexpr int kListTop = 2;
constexpr int kListRows = kBodyBottom - kListTop + 1;
constexpr int kModelRow = 2;
constexpr int kWorkspaceRow = 3;
constexpr int kModeRow = 4;
constexpr int kPromptTop = 6;
constexpr int kFieldLabelCols = 10;
constexpr int kPromptRows = kBodyBottom - kPromptTop + 1;

constexpr std::array<RuntimeMode, 4> kModes = {RuntimeMode::ApprovalRequired, RuntimeMode::AutoAcceptEdits, RuntimeMode::Auto, RuntimeMode::FullAccess};

RuntimeMode stepMode(RuntimeMode mode, int step)
{
    const int count = static_cast<int>(kModes.size());
    const int at = static_cast<int>(std::find(kModes.begin(), kModes.end(), mode) - kModes.begin());
    return kModes[(at + step + count) % count];
}

std::string workspaceLabel(Workspace workspace)
{
    return workspace == Workspace::Worktree ? "new worktree" : std::string(workspaceName(workspace));
}

std::string field(std::string label, std::string_view value, bool focused)
{
    label.resize(kFieldLabelCols, ' ');
    return label + (focused ? "[" + std::string(value) + "]" : std::string(value));
}

}

App::Out App::listProjects()
{
    Out out;
    if (!send(out, encodeListProjects(nextId()), "list_projects")) {
        return out;
    }
    projects_.reset();
    launchId_.clear();
    projectSelected_ = 0;
    projectTop_ = 0;
    screen_ = Screen::Projects;
    return out;
}

App::Out App::projectsKey(Key key)
{
    const int count = projects_ ? static_cast<int>(projects_->items.size()) : 0;
    switch (key.name) {
    case KeyName::Up:
        projectSelected_ = std::max(0, projectSelected_ - 1);
        break;
    case KeyName::Down:
        projectSelected_ = std::min(std::max(0, count - 1), projectSelected_ + 1);
        break;
    case KeyName::Enter:
        if (count > 0) {
            const ProjectDefaults &defaults = projects_->items[projectSelected_].defaults;
            modelStop_ = 0;
            workspace_ = defaults.workspace;
            mode_ = defaults.runtimeMode;
            field_ = Field::None;
            prompt_.clear();
            screen_ = Screen::Prompt;
        }
        return {};
    case KeyName::Backspace:
    case KeyName::Esc:
        screen_ = Screen::Home;
        return {};
    default:
        return {};
    }
    projectTop_ = keepVisible(projectTop_, projectSelected_, kListRows);
    return {};
}

App::Out App::promptKey(Key key)
{
    Out out;
    const int step = key.name == KeyName::Right ? 1 : -1;
    switch (key.name) {
    case KeyName::Tab:
        if (field_ == Field::None) {
            field_ = projects_->models.empty() ? Field::Workspace : Field::Model;
        } else {
            field_ = field_ == Field::Model ? Field::Workspace : field_ == Field::Workspace ? Field::Mode : Field::None;
        }
        break;
    case KeyName::Left:
    case KeyName::Right:
        if (field_ == Field::Model) {
            const int stops = static_cast<int>(projects_->models.size()) + 1;
            modelStop_ = (modelStop_ + step + stops) % stops;
        } else if (field_ == Field::Workspace) {
            workspace_ = workspace_ == Workspace::Root ? Workspace::Worktree : Workspace::Root;
        } else if (field_ == Field::Mode) {
            mode_ = stepMode(mode_, step);
        }
        break;
    case KeyName::Enter: {
        if (!launchId_.empty()) {
            inform("starting...", Color::Ok);
            break;
        }
        if (prompt_.empty()) {
            inform("type a prompt first", Color::Warn);
            break;
        }
        LaunchOptions options;
        if (modelStop_ > 0) {
            options.model = projects_->models[modelStop_ - 1].id;
        }
        options.workspace = workspace_;
        options.runtimeMode = mode_;
        const std::string id = nextId();
        if (send(out, encodeLaunch(id, projects_->items[projectSelected_].projectId, prompt_, options), "launch")) {
            launchId_ = id;
            inform("starting task", Color::Ok);
        }
        break;
    }
    case KeyName::Backspace:
        if (prompt_.empty()) {
            screen_ = Screen::Projects;
        } else {
            prompt_.pop_back();
        }
        break;
    case KeyName::Esc:
        screen_ = Screen::Projects;
        break;
    case KeyName::Char:
        type(prompt_, key.ch, kReplyTextMax, "launch_text_max", "prompt");
        break;
    default:
        break;
    }
    return out;
}

void App::drawProjects(Grid &grid) const
{
    std::vector<Line> lines;
    if (!projects_) {
        lines.push_back(Line{"loading projects", Color::Dim, -1});
    } else {
        for (size_t i = 0; i < projects_->items.size(); ++i) {
            lines.push_back(Line{projects_->items[i].name, Color::Text, static_cast<int>(i)});
        }
        if (projects_->items.empty()) {
            lines.push_back(Line{"no projects", Color::Dim, -1});
        }
        if (const auto &cut = projects_->truncated) {
            const std::string notice = "+" + std::to_string(cut->hidden) + " more projects: " + cut->budget + "=" + std::to_string(cut->limit) +
                                       ", needed " + std::to_string(cut->actual);
            for (std::string &line : wrapWords(notice, Grid::Cols)) {
                lines.push_back(Line{std::move(line), Color::Warn, -1});
            }
        }
    }
    const bool atEnd = projects_ && projectSelected_ + 1 >= static_cast<int>(projects_->items.size());
    const int top = clampTop(atEnd ? static_cast<int>(lines.size()) : projectTop_, static_cast<int>(lines.size()), kListRows);
    grid.put(1, 0, "pick a project", Color::Dim);
    for (int i = 0; i < kListRows && top + i < static_cast<int>(lines.size()); ++i) {
        const Line &line = lines[top + i];
        grid.put(kListTop + i, 0, line.text, line.color);
        if (line.row >= 0 && line.row == projectSelected_) {
            grid.selectRow(kListTop + i);
        }
    }
    drawHint(grid, "^v move  Enter pick  Esc back");
    drawBar(grid, "new task", "1/2");
}

void App::drawPrompt(Grid &grid) const
{
    const ProjectItem &project = projects_->items[projectSelected_];
    grid.put(1, 0, project.name, Color::Hdr);
    const std::string &model = modelStop_ > 0 ? projects_->models[modelStop_ - 1].label : project.defaults.model;
    grid.put(kModelRow, 0, field("model", model, field_ == Field::Model), field_ == Field::Model ? Color::Text : Color::Dim);
    grid.put(kWorkspaceRow, 0, field("workspace", workspaceLabel(workspace_), field_ == Field::Workspace), field_ == Field::Workspace ? Color::Text : Color::Dim);
    grid.put(kModeRow, 0, field("mode", runtimeModeName(mode_), field_ == Field::Mode), field_ == Field::Mode ? Color::Text : Color::Dim);

    const std::vector<std::string> wrapped = wrapWords(prompt_ + std::string(kCursor), Grid::Cols - static_cast<int>(kPrompt.size()));
    const int first = std::max(0, static_cast<int>(wrapped.size()) - kPromptRows);
    for (int i = first; i < static_cast<int>(wrapped.size()); ++i) {
        grid.put(kPromptTop + i - first, 0, std::string(i == 0 ? kPrompt : kContinue) + wrapped[i]);
    }
    drawHint(grid, field_ == Field::None ? "Enter start  Tab opts  ` talk  Esc back" : "<> change  Tab next  Enter start");
    drawBar(grid, "new task", "2/2");
}

}
