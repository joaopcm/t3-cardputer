#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace t3 {

enum class KeyName { Char, Enter, FnEnter, Backspace, Tab, Esc, Up, Down, Left, Right, FnS, TalkDown, TalkUp };

struct Key {
    KeyName name;
    char ch = 0;
};

struct NamedKey {
    KeyName name;
    std::string_view text;
};

inline constexpr NamedKey kNamedKeys[] = {
    {KeyName::Enter, "enter"},
    {KeyName::FnEnter, "fn+enter"},
    {KeyName::Backspace, "bksp"},
    {KeyName::Tab, "tab"},
    {KeyName::Esc, "esc"},
    {KeyName::Up, "up"},
    {KeyName::Down, "down"},
    {KeyName::Left, "left"},
    {KeyName::Right, "right"},
    {KeyName::FnS, "fn+s"},
    {KeyName::TalkDown, "talk-down"},
    {KeyName::TalkUp, "talk-up"},
};

inline constexpr std::string_view kCharPrefix = "char:";

inline std::optional<Key> parseKeyName(std::string_view text)
{
    if (text.size() == kCharPrefix.size() + 1 && text.substr(0, kCharPrefix.size()) == kCharPrefix) {
        const char c = text.back();
        if (c < 0x20 || c > 0x7e) {
            return std::nullopt;
        }
        return Key{KeyName::Char, c};
    }
    for (const NamedKey &named : kNamedKeys) {
        if (named.text == text) {
            return Key{named.name};
        }
    }
    return std::nullopt;
}

inline std::string keyNameString(const Key &key)
{
    if (key.name == KeyName::Char) {
        return std::string(kCharPrefix) + key.ch;
    }
    for (const NamedKey &named : kNamedKeys) {
        if (named.name == key.name) {
            return std::string(named.text);
        }
    }
    return {};
}

}
