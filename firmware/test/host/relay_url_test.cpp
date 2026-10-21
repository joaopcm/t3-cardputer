#include "doctest.h"

#include <optional>
#include <string>
#include <variant>

#include "t3/relay_url.h"

namespace {

t3::RelayUrl parsed(std::string_view text)
{
    const std::variant<t3::RelayUrl, std::string> result = t3::parseRelayUrl(text);
    REQUIRE_MESSAGE(std::holds_alternative<t3::RelayUrl>(result), text << ": " << std::get<std::string>(result));
    return std::get<t3::RelayUrl>(result);
}

std::string refused(std::string_view text)
{
    const std::variant<t3::RelayUrl, std::string> result = t3::parseRelayUrl(text);
    REQUIRE_MESSAGE(std::holds_alternative<std::string>(result), text << " was accepted");
    return std::get<std::string>(result);
}

}

TEST_CASE("an https url with an uppercase host, a port and a trailing slash is normalized")
{
    const t3::RelayUrl url = parsed("https://Relay.Example.com:8443/");
    CHECK(url.https == "https://relay.example.com:8443");
    CHECK(url.wss == "wss://relay.example.com:8443");
}

TEST_CASE("a wss url gives the same relay in both forms")
{
    const t3::RelayUrl url = parsed("wss://relay.example.com");
    CHECK(url.https == "https://relay.example.com");
    CHECK(url.wss == "wss://relay.example.com");
}

TEST_CASE("no scheme is https")
{
    const t3::RelayUrl url = parsed("relay.example.com:8443");
    CHECK(url.https == "https://relay.example.com:8443");
    CHECK(url.wss == "wss://relay.example.com:8443");
}

TEST_CASE("localhost needs no dot")
{
    CHECK(parsed("localhost:8443").https == "https://localhost:8443");
}

TEST_CASE("plain http is refused by name")
{
    CHECK(refused("http://relay.example.com") == "relay url must be https:// or wss://");
    CHECK(refused("ws://relay.example.com") == "relay url must be https:// or wss://");
}

TEST_CASE("a path, a user or a query is refused")
{
    for (const char *text : {"https://relay.example.com/v1", "https://u@relay.example.com", "https://relay.example.com?x"}) {
        CHECK_MESSAGE(refused(text) == "relay url: host and port only, no path", text);
    }
}

TEST_CASE("a port past 65535 is refused with the number")
{
    CHECK(refused("https://relay.example.com:99999") == "relay url: port 99999 out of range");
    CHECK(refused("https://relay.example.com:0") == "relay url: port 0 out of range");
    CHECK(refused("https://relay.example.com:84a3") == "relay url: port 84a3 is not a number");
}

TEST_CASE("a host that is not a dns name is refused")
{
    CHECK(refused("https://relay") == "relay url: host relay is not a dns name");
    CHECK(refused("https://relay_host.example.com") == "relay url: host relay_host.example.com is not a dns name");
    CHECK(refused("https://:8443") == "relay url: no host");
    CHECK(refused("") == "relay url: no host");
}

TEST_CASE("a url over the budget names it")
{
    const std::string host = std::string(321 - 8 - 4, 'a') + ".com";
    const std::string text = "https://" + host;
    REQUIRE(text.size() == 321);
    CHECK(refused(text) == "relay_url_max=320, url needed 321");
    CHECK(parsed(text.substr(0, 320 - 4) + ".com").https.size() == 320);
}

TEST_CASE("only replacing a stored relay with a different one wipes the token")
{
    CHECK_FALSE(t3::relayChangeWipesToken(std::nullopt, "https://relay.example.com:8443"));
    CHECK_FALSE(t3::relayChangeWipesToken(std::string_view(""), "https://relay.example.com:8443"));
    CHECK_FALSE(t3::relayChangeWipesToken(std::string_view("https://relay.example.com:8443"), "https://relay.example.com:8443"));
    CHECK(t3::relayChangeWipesToken(std::string_view("https://relay.example.com:8443"), "https://other.example.com:8443"));
}
