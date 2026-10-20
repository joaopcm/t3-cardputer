#pragma once

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>

#include "t3/grid.h"

namespace t3::screen {

inline constexpr int kBodyTop = 1;
inline constexpr int kBodyBottom = Grid::Rows - 2;
inline constexpr int kBodyRows = kBodyBottom - kBodyTop + 1;
inline constexpr int kHintRow = Grid::Rows - 1;
inline constexpr std::string_view kPrompt = "> ";
inline constexpr std::string_view kContinue = "  ";
inline constexpr std::string_view kCursor = "_";

inline char upper(char c)
{
    return static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
}

inline std::string inputLine(std::string_view text)
{
    const size_t room = Grid::Cols - kPrompt.size() - kCursor.size();
    const std::string_view tail = text.size() > room ? text.substr(text.size() - room) : text;
    return std::string(kPrompt) + std::string(tail) + std::string(kCursor);
}

inline int clampTop(int top, int total, int visible)
{
    return std::clamp(top, 0, std::max(0, total - visible));
}

inline int keepVisible(int top, int line, int visible)
{
    if (line < top) {
        return line;
    }
    if (line >= top + visible) {
        return line - visible + 1;
    }
    return top;
}

inline std::string padLeft(std::string_view text, size_t width)
{
    return text.size() >= width ? std::string(text) : std::string(width - text.size(), ' ') + std::string(text);
}

}
