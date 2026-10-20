#include "t3/keymap.h"

#include <array>

namespace t3 {

namespace {

constexpr int kMatrixRows = 7;
constexpr int kMatrixCols = 8;
constexpr int kCodeStride = 10;
constexpr int kKeyboardCols = 14;
constexpr int kKeyboardRows = 4;
constexpr int kColsPerRow = kMatrixCols / kKeyboardRows;

static_assert(kMatrixRows * kColsPerRow == kKeyboardCols);

enum Special : char { Fn = 1, Shift = 2, Tab = 3, Enter = 4, Backspace = 5, Ignored = 6 };

constexpr std::array<std::array<char, kKeyboardCols>, kKeyboardRows> kPlain = {{
    {'`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', Backspace},
    {Tab, 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'},
    {Fn, Shift, 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', '\'', Enter},
    {Ignored, Ignored, Ignored, 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', ' '},
}};

constexpr std::array<std::array<char, kKeyboardCols>, kKeyboardRows> kShifted = {{
    {'~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', Backspace},
    {Tab, 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '{', '}', '|'},
    {Fn, Shift, 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ':', '"', Enter},
    {Ignored, Ignored, Ignored, 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '<', '>', '?', ' '},
}};

constexpr char kBacktick = '`';
constexpr char kLetterS = 's';

std::optional<Key> arrow(char plain)
{
    switch (plain) {
    case ';':
        return Key{KeyName::Up};
    case '.':
        return Key{KeyName::Down};
    case ',':
        return Key{KeyName::Left};
    case '/':
        return Key{KeyName::Right};
    default:
        return std::nullopt;
    }
}

}

std::optional<Key> KeyDecoder::onEvent(uint8_t code, bool pressed)
{
    if (code == 0) {
        return std::nullopt;
    }
    const int index = code - 1;
    const int row = index / kCodeStride;
    const int col = index % kCodeStride;
    if (row >= kMatrixRows || col >= kMatrixCols) {
        return std::nullopt;
    }
    const int x = row * kColsPerRow + col / kKeyboardRows;
    const int y = col % kKeyboardRows;
    const char plain = kPlain[y][x];

    if (plain == Fn) {
        fn_ = pressed;
        return std::nullopt;
    }
    if (plain == Shift) {
        shift_ = pressed;
        return std::nullopt;
    }
    if (plain == kBacktick && !pressed) {
        if (!talking_) {
            return std::nullopt;
        }
        talking_ = false;
        return Key{KeyName::TalkUp};
    }
    if (!pressed) {
        return std::nullopt;
    }
    if (plain == kBacktick && !fn_ && !shift_) {
        talking_ = true;
        return Key{KeyName::TalkDown};
    }
    if (fn_) {
        if (plain == kBacktick) {
            return Key{KeyName::Esc};
        }
        if (plain == Enter) {
            return Key{KeyName::FnEnter};
        }
        if (plain == kLetterS) {
            return Key{KeyName::FnS};
        }
        return arrow(plain);
    }
    const char value = shift_ ? kShifted[y][x] : plain;
    switch (value) {
    case Tab:
        return Key{KeyName::Tab};
    case Enter:
        return Key{KeyName::Enter};
    case Backspace:
        return Key{KeyName::Backspace};
    case Ignored:
        return std::nullopt;
    default:
        return Key{KeyName::Char, value};
    }
}

}
