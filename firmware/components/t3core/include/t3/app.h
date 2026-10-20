#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "t3/grid.h"
#include "t3/keys.h"
#include "t3/protocol.h"

namespace t3 {

std::vector<std::string> wrapWords(std::string_view text, int width);

class App {
public:
    struct Out {
        std::vector<std::string> send;
        enum class Audio { None, Start, Stop, Cancel } audio = Audio::None;
    };

    App(const HelloCaps &caps, uint64_t idSeed);

    Out onKey(Key key);
    Out onRelay(const RelayMsg &msg);
    Out onFrame(std::string_view json);
    Out onLinkStatus(std::string_view status);
    void draw(Grid &grid) const;
    std::string_view screenName() const;

private:
    enum class Screen { Connecting, Home, Thread, Request, Projects, Prompt };
    enum class Field { None, Workspace, Mode };

    struct Line {
        std::string text;
        Color color = Color::Text;
        int row = -1;
    };

    struct RequestLayout {
        std::vector<Line> scroll;
        std::vector<Line> pinned;
        int scrollRows = 0;
    };

    std::string nextId() { return ids_.next(); }
    bool send(Out &out, std::optional<std::string> frame, std::string_view what);
    void inform(std::string text, Color color = Color::Red);
    void type(std::string &text, char c, int max, std::string_view budget, std::string_view what);
    Out refresh();
    std::string health() const;
    const HomeRow *homeRow(std::string_view threadId) const;
    void drawBar(Grid &grid, std::string_view left, std::string_view right, Color rightColor = Color::Text) const;
    static void drawHint(Grid &grid, std::string_view hint);
    void onAck(const Ack &ack);
    void onRequest(const Request &request);

    void onHome(const Home &home);
    Out homeKey(Key key);
    std::vector<Line> homeLines() const;
    int homeSelectedLine(const std::vector<Line> &lines) const;
    void showHomeSelection();
    void drawHome(Grid &grid) const;

    Out openThread(std::string threadId);
    Out threadKey(Key key);
    void drawThread(Grid &grid) const;

    Out requestKey(Key key);
    RequestLayout requestLayout() const;
    Out respond(Option option, std::optional<std::string> text);
    void drawRequest(Grid &grid) const;

    Out listProjects();
    Out projectsKey(Key key);
    Out promptKey(Key key);
    void drawProjects(Grid &grid) const;
    void drawPrompt(Grid &grid) const;

    HelloCaps caps_;
    IdGen ids_;
    Screen screen_ = Screen::Connecting;
    std::string linkStatus_ = "starting";
    std::string notice_;
    Color noticeColor_ = Color::Red;

    std::optional<Home> home_;
    int homeSelected_ = 0;
    int homeTop_ = 0;

    std::string threadId_;
    std::optional<ThreadPage> page_;
    std::string reply_;
    std::string replyId_;
    std::string replySent_;
    std::string openId_;

    std::optional<Request> request_;
    int requestTop_ = 0;
    std::optional<Option> typingFor_;
    std::string answer_;
    std::string respondId_;
    std::optional<Request> responded_;

    std::optional<Projects> projects_;
    int projectSelected_ = 0;
    int projectTop_ = 0;
    std::string prompt_;
    Workspace workspace_ = Workspace::Root;
    RuntimeMode mode_ = RuntimeMode::ApprovalRequired;
    Field field_ = Field::None;
    std::string launchId_;
};

}
