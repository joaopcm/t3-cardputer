#include "doctest.h"

#include "t3/keymap.h"

namespace {

using t3::Key;
using t3::KeyDecoder;
using t3::KeyName;

constexpr uint8_t kRowStride = 10;

uint8_t code(int x, int y)
{
    const int row = x / 2;
    const int col = y + (x % 2 == 0 ? 0 : 4);
    return static_cast<uint8_t>(row * kRowStride + col + 1);
}

struct Pad {
    KeyDecoder decoder;

    std::optional<Key> down(int x, int y) { return decoder.onEvent(code(x, y), true); }
    std::optional<Key> up(int x, int y) { return decoder.onEvent(code(x, y), false); }
    std::optional<Key> tap(int x, int y)
    {
        const auto key = down(x, y);
        up(x, y);
        return key;
    }
};

constexpr int kFnX = 0, kFnY = 2;
constexpr int kShiftX = 1, kShiftY = 2;

void checkChar(const std::optional<Key> &key, char want)
{
    REQUIRE(key.has_value());
    CHECK(key->name == KeyName::Char);
    CHECK(key->ch == want);
}

}

TEST_CASE("the tca8418 event code walks the 7x8 matrix onto the 4x14 keyboard")
{
    CHECK(code(0, 0) == 1);
    CHECK(code(1, 0) == 5);
    CHECK(code(13, 3) == 68);
}

TEST_CASE("letters, digits and punctuation decode unshifted")
{
    Pad pad;
    checkChar(pad.tap(1, 1), 'q');
    checkChar(pad.tap(3, 2), 's');
    checkChar(pad.tap(3, 3), 'z');
    checkChar(pad.tap(1, 0), '1');
    checkChar(pad.tap(11, 0), '-');
    checkChar(pad.tap(12, 0), '=');
    checkChar(pad.tap(12, 2), '\'');
    checkChar(pad.tap(13, 1), '\\');
    checkChar(pad.tap(13, 3), ' ');
}

TEST_CASE("shift gives capitals and the shifted symbols while held")
{
    Pad pad;
    pad.down(kShiftX, kShiftY);
    checkChar(pad.tap(1, 1), 'Q');
    checkChar(pad.tap(1, 0), '!');
    checkChar(pad.tap(12, 0), '+');
    checkChar(pad.tap(11, 2), ':');
    checkChar(pad.tap(12, 2), '"');
    checkChar(pad.tap(12, 3), '?');
    checkChar(pad.tap(0, 0), '~');
    pad.up(kShiftX, kShiftY);
    checkChar(pad.tap(1, 1), 'q');
}

TEST_CASE("enter, tab and backspace are named keys")
{
    Pad pad;
    CHECK(pad.tap(13, 2)->name == KeyName::Enter);
    CHECK(pad.tap(0, 1)->name == KeyName::Tab);
    CHECK(pad.tap(13, 0)->name == KeyName::Backspace);
}

TEST_CASE("fn with ; . , / gives the arrows")
{
    Pad pad;
    pad.down(kFnX, kFnY);
    CHECK(pad.tap(11, 2)->name == KeyName::Up);
    CHECK(pad.tap(11, 3)->name == KeyName::Down);
    CHECK(pad.tap(10, 3)->name == KeyName::Left);
    CHECK(pad.tap(12, 3)->name == KeyName::Right);
    pad.up(kFnX, kFnY);
    checkChar(pad.tap(11, 2), ';');
    checkChar(pad.tap(11, 3), '.');
    checkChar(pad.tap(10, 3), ',');
    checkChar(pad.tap(12, 3), '/');
}

TEST_CASE("fn+enter, fn+s and fn+backtick are their own keys")
{
    Pad pad;
    pad.down(kFnX, kFnY);
    CHECK(pad.tap(13, 2)->name == KeyName::FnEnter);
    CHECK(pad.tap(3, 2)->name == KeyName::FnS);
    CHECK(pad.tap(0, 0)->name == KeyName::Esc);
}

TEST_CASE("other fn chords do nothing")
{
    Pad pad;
    pad.down(kFnX, kFnY);
    CHECK_FALSE(pad.tap(1, 0).has_value());
    CHECK_FALSE(pad.tap(2, 1).has_value());
}

TEST_CASE("holding backtick is TalkDown on press and TalkUp on release")
{
    Pad pad;
    const auto down = pad.down(0, 0);
    REQUIRE(down.has_value());
    CHECK(down->name == KeyName::TalkDown);
    const auto up = pad.up(0, 0);
    REQUIRE(up.has_value());
    CHECK(up->name == KeyName::TalkUp);
}

TEST_CASE("fn+backtick is Esc and its release is silent")
{
    Pad pad;
    pad.down(kFnX, kFnY);
    CHECK(pad.down(0, 0)->name == KeyName::Esc);
    CHECK_FALSE(pad.up(0, 0).has_value());
}

TEST_CASE("fn released before a held backtick still ends the talk")
{
    Pad pad;
    pad.down(0, 0);
    pad.down(kFnX, kFnY);
    pad.up(kFnX, kFnY);
    CHECK(pad.up(0, 0)->name == KeyName::TalkUp);
}

TEST_CASE("a key's release and the modifier keys make no key of their own")
{
    Pad pad;
    CHECK_FALSE(pad.down(kFnX, kFnY).has_value());
    CHECK_FALSE(pad.up(kFnX, kFnY).has_value());
    CHECK_FALSE(pad.down(kShiftX, kShiftY).has_value());
    pad.up(kShiftX, kShiftY);
    pad.down(2, 1);
    CHECK_FALSE(pad.up(2, 1).has_value());
}

TEST_CASE("ctrl, opt and alt are ignored")
{
    Pad pad;
    CHECK_FALSE(pad.tap(0, 3).has_value());
    CHECK_FALSE(pad.tap(1, 3).has_value());
    CHECK_FALSE(pad.tap(2, 3).has_value());
}

TEST_CASE("codes outside the matrix and the empty fifo decode to nothing")
{
    KeyDecoder decoder;
    CHECK_FALSE(decoder.onEvent(0, true).has_value());
    CHECK_FALSE(decoder.onEvent(81, true).has_value());
    CHECK_FALSE(decoder.onEvent(0x7f, true).has_value());
}
