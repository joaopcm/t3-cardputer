#include "doctest.h"

#include <string>

#include "t3/keys.h"

TEST_CASE("every key name round-trips")
{
    const char *names[] = {"char:a", "char:Z", "char:7", "char: ", "char::", "enter", "fn+enter", "bksp", "tab", "esc",
                           "up",     "down",   "left",   "right",  "fn+s",  "talk-down", "talk-up"};
    for (const char *name : names) {
        const auto key = t3::parseKeyName(name);
        REQUIRE_MESSAGE(key.has_value(), name);
        CHECK(t3::keyNameString(*key) == name);
    }
}

TEST_CASE("char keys carry their character")
{
    const auto key = t3::parseKeyName("char:q");
    REQUIRE(key.has_value());
    CHECK(key->name == t3::KeyName::Char);
    CHECK(key->ch == 'q');
}

TEST_CASE("bad key names are rejected")
{
    for (const char *name : {"", "char:", "char:ab", "char:\x01", "Enter", "fn+x", "enter ", "unknown"}) {
        CHECK_FALSE(t3::parseKeyName(name).has_value());
    }
}
