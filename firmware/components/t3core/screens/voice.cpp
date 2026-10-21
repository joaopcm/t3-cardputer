#include <algorithm>
#include <cmath>

#include "screens/screen.h"
#include "t3/app.h"

namespace t3 {

using namespace screen;

namespace {

constexpr int kMeterRow = 2;
constexpr int kTranscriptLabelRow = 4;
constexpr int kTranscriptTop = 5;
constexpr int kTranscriptRows = kBodyBottom - kTranscriptTop + 1;
constexpr std::string_view kMeterRamp = " .:|";
// receipt: docs/receipts/2026-10-21-firmware-voice.md "meter"
constexpr int kMeterStepDbfs[] = {-80, -40, -25};
static_assert(std::size(kMeterStepDbfs) + 1 == kMeterRamp.size());
constexpr double kFullScale = 32768.0;

char meterChar(int dbfs)
{
    size_t step = 0;
    for (int threshold : kMeterStepDbfs) {
        step += dbfs >= threshold ? 1 : 0;
    }
    return kMeterRamp[step];
}

std::string joined(std::string_view first, std::string_view second)
{
    if (first.empty() || second.empty()) {
        return std::string(first.empty() ? second : first);
    }
    return std::string(first) + (first.back() == ' ' ? "" : " ") + std::string(second);
}

std::string clock(uint32_t ms)
{
    const uint32_t seconds = ms / 1000;
    const uint32_t rest = seconds % 60;
    return std::to_string(seconds / 60) + (rest < 10 ? ":0" : ":") + std::to_string(rest);
}

}

int chunkDbfs(const int16_t *samples, size_t count)
{
    double sum = 0;
    for (size_t i = 0; i < count; ++i) {
        sum += static_cast<double>(samples[i]) * samples[i];
    }
    const double rms = count == 0 ? 0 : std::sqrt(sum / static_cast<double>(count));
    if (rms <= 0) {
        return kSilenceDbfs;
    }
    const int dbfs = static_cast<int>(std::lround(20 * std::log10(rms / kFullScale)));
    return std::clamp(dbfs, kSilenceDbfs, 0);
}

bool App::recording() const
{
    return screen_ == Screen::Voice && voice_ == Voice::Recording;
}

App::Out App::startVoice(uint32_t nowMs)
{
    if (!linkStatus_.empty()) {
        inform("voice: not connected, " + linkStatus_);
        return {};
    }
    if (!audioEndId_.empty()) {
        inform("voice: still transcribing the last recording", Color::Warn);
        return {};
    }
    Out out;
    const std::string id = nextId();
    if (!send(out, encodeAudioStart(id), "audio_start")) {
        return out;
    }
    if (screen_ != Screen::Voice) {
        voiceFrom_ = screen_;
        voiceText_.clear();
    }
    audioStartId_ = id;
    voicePartial_.clear();
    meter_.clear();
    recStartMs_ = nowMs;
    recMs_ = 0;
    voice_ = Voice::Recording;
    screen_ = Screen::Voice;
    out.audio = Out::Audio::Start;
    return out;
}

App::Out App::stopVoice(uint32_t nowMs)
{
    Out out;
    out.audio = Out::Audio::Stop;
    recMs_ = nowMs - recStartMs_;
    const std::string id = nextId();
    if (!send(out, encodeAudioEnd(id), "audio_end")) {
        leaveVoice();
        return out;
    }
    audioEndId_ = id;
    voice_ = Voice::Transcribing;
    return out;
}

App::Out App::cancelRecording(std::string_view why)
{
    Out out;
    out.audio = Out::Audio::Cancel;
    send(out, encodeAudioCancel(nextId()), "audio_cancel");
    leaveVoice();
    if (!why.empty()) {
        inform("voice: " + std::string(why));
    }
    return out;
}

void App::leaveVoice()
{
    voicePartial_.clear();
    if (voiceText_.empty()) {
        screen_ = voiceFrom_;
    } else {
        voice_ = Voice::Review;
    }
}

bool App::commitVoice()
{
    const bool reply = voiceFrom_ == Screen::Thread;
    std::string &line = reply ? reply_ : prompt_;
    std::string combined = joined(line, voiceText_);
    if (static_cast<int>(combined.size()) > kReplyTextMax) {
        inform(std::string(reply ? "reply_text_max=" : "launch_text_max=") + std::to_string(kReplyTextMax) + ", " +
               (reply ? "reply" : "prompt") + " needed " + std::to_string(combined.size()));
        return false;
    }
    line = std::move(combined);
    voiceText_.clear();
    screen_ = voiceFrom_;
    return true;
}

App::Out App::voiceKey(Key key, uint32_t nowMs)
{
    const bool leave = key.name == KeyName::Backspace || key.name == KeyName::Esc;
    switch (voice_) {
    case Voice::Recording:
        if (key.name == KeyName::TalkUp) {
            return stopVoice(nowMs);
        }
        return leave ? cancelRecording("") : Out{};
    case Voice::Transcribing:
        if (leave) {
            voiceText_.clear();
            leaveVoice();
        } else if (key.name == KeyName::TalkDown) {
            inform("voice: still transcribing the last recording", Color::Warn);
        }
        return {};
    case Voice::Review:
        break;
    }
    switch (key.name) {
    case KeyName::TalkDown:
        return startVoice(nowMs);
    case KeyName::Enter:
    case KeyName::FnEnter:
        if (!commitVoice()) {
            return {};
        }
        return voiceFrom_ == Screen::Thread ? threadKey(key) : promptKey(key);
    case KeyName::Char:
        if (key.ch == 'e' || key.ch == 'E') {
            commitVoice();
        }
        return {};
    case KeyName::Backspace:
    case KeyName::Esc:
        voiceText_.clear();
        screen_ = voiceFrom_;
        return {};
    default:
        return {};
    }
}

App::Out App::onAudioAck(const Ack &ack)
{
    if (ack.ok) {
        return {};
    }
    const std::string why = ack.error.value_or("no reason given");
    if (ack.id == audioEndId_) {
        audioEndId_.clear();
        if (screen_ == Screen::Voice && voice_ == Voice::Transcribing) {
            leaveVoice();
        }
        inform("voice: " + why);
        return {};
    }
    audioEndId_.clear();
    if (recording()) {
        return cancelRecording("refused: " + why);
    }
    Out out;
    send(out, encodeAudioCancel(nextId()), "audio_cancel");
    if (screen_ == Screen::Voice && voice_ == Voice::Transcribing) {
        leaveVoice();
    }
    inform("voice: refused: " + why);
    return out;
}

std::optional<App::Out> App::onAudioError(const Error &error)
{
    if ((error.code == ErrorCode::BadAudio || error.code == ErrorCode::AudioNotStarted) && recording()) {
        return cancelRecording(error.message);
    }
    if (error.code == ErrorCode::Internal && !audioEndId_.empty()) {
        audioEndId_.clear();
        if (screen_ == Screen::Voice && voice_ == Voice::Transcribing) {
            leaveVoice();
        }
        inform("voice: " + (error.message.empty() ? std::string("transcription failed") : error.message));
        return Out{};
    }
    return std::nullopt;
}

App::Out App::onVoiceLinkLost()
{
    Out out;
    const bool transcribing = screen_ == Screen::Voice && voice_ == Voice::Transcribing;
    audioEndId_.clear();
    if (recording()) {
        out.audio = Out::Audio::Cancel;
        leaveVoice();
        inform("voice: connection lost");
    } else if (transcribing) {
        leaveVoice();
        inform("voice: connection lost, transcript lost");
    }
    return out;
}

void App::onTranscript(std::string_view text)
{
    if (audioEndId_.empty()) {
        return;
    }
    audioEndId_.clear();
    if (screen_ != Screen::Voice || voice_ != Voice::Transcribing) {
        return;
    }
    voicePartial_.clear();
    voice_ = Voice::Review;
    if (text.empty()) {
        inform("voice: nothing heard", Color::Warn);
        return;
    }
    std::string combined = joined(voiceText_, text);
    if (static_cast<int>(combined.size()) > kReplyTextMax) {
        inform("reply_text_max=" + std::to_string(kReplyTextMax) + ", transcript needed " + std::to_string(combined.size()));
        return;
    }
    voiceText_ = std::move(combined);
}

void App::onAudio(int dbfs, uint32_t nowMs)
{
    if (!recording()) {
        return;
    }
    recMs_ = nowMs - recStartMs_;
    meter_.push_back(meterChar(dbfs));
    if (meter_.size() > static_cast<size_t>(Grid::Cols)) {
        meter_.erase(0, meter_.size() - Grid::Cols);
    }
}

App::Out App::onAudioFailed(std::string_view why)
{
    if (!recording()) {
        return {};
    }
    return cancelRecording(why);
}

void App::drawVoice(Grid &grid) const
{
    grid.put(kMeterRow, 0, meter_, Color::Run);
    grid.put(kTranscriptLabelRow, 0, "-- transcript --", Color::Dim);
    std::string shown = joined(voiceText_, voicePartial_);
    if (voice_ == Voice::Review) {
        shown += kCursor;
    }
    const std::vector<std::string> lines = shown.empty() ? std::vector<std::string>{} : wrapWords(shown, Grid::Cols);
    const int first = std::max(0, static_cast<int>(lines.size()) - kTranscriptRows);
    for (int i = first; i < static_cast<int>(lines.size()); ++i) {
        grid.put(kTranscriptTop + i - first, 0, lines[i]);
    }

    switch (voice_) {
    case Voice::Recording:
        drawHint(grid, "release ` to stop  Bksp cancel");
        break;
    case Voice::Transcribing:
        drawHint(grid, "transcribing...  Bksp discard");
        break;
    case Voice::Review:
        drawHint(grid, "Enter send  E edit  Bksp discard  ` more");
        break;
    }

    std::string project;
    if (voiceFrom_ == Screen::Prompt && projects_) {
        project = projects_->items[projectSelected_].name;
    } else if (page_ && page_->threadId == threadId_) {
        project = page_->header.project;
    } else if (const HomeRow *row = homeRow(threadId_)) {
        project = row->project;
    }
    const std::string left = project + " - " + (voiceFrom_ == Screen::Prompt ? "new task" : "reply");
    switch (voice_) {
    case Voice::Recording:
        drawBar(grid, left, "REC " + clock(recMs_), Color::Red);
        break;
    case Voice::Transcribing:
        drawBar(grid, left, "transcribing", Color::Run);
        break;
    case Voice::Review:
        drawBar(grid, left, clock(recMs_), Color::Dim);
        break;
    }
}

}
