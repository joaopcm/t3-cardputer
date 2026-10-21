#include "doctest.h"

#include <memory>
#include <set>
#include <string>
#include <variant>

#include "cJSON.h"
#include "t3/provision.h"

namespace {

t3::ProvisionRequest accepted(std::string_view json)
{
    std::variant<t3::ProvisionRequest, std::string> result = t3::parseProvision(json);
    REQUIRE_MESSAGE(std::holds_alternative<t3::ProvisionRequest>(result), json << ": " << std::get<std::string>(result));
    return std::get<t3::ProvisionRequest>(std::move(result));
}

std::string refused(std::string_view json)
{
    const std::variant<t3::ProvisionRequest, std::string> result = t3::parseProvision(json);
    REQUIRE_MESSAGE(std::holds_alternative<std::string>(result), json << " was accepted");
    return std::get<std::string>(result);
}

std::string wifiFrame(std::string_view ssid, std::string_view password)
{
    return R"({"wifi":{"ssid":")" + std::string(ssid) + R"(","password":")" + std::string(password) + R"("}})";
}

}

TEST_CASE("a full frame sets wifi, a normalized relay and the pair code")
{
    const t3::ProvisionRequest request =
        accepted(R"({"wifi":{"ssid":"home","password":"correct horse"},"relay":"https://Relay.Example.com:8443/","code":"7kq2m9xa"})");
    REQUIRE(request.wifi);
    CHECK(request.wifi->ssid == "home");
    CHECK(request.wifi->password == "correct horse");
    REQUIRE(request.relay);
    CHECK(request.relay->https == "https://relay.example.com:8443");
    CHECK(request.relay->wss == "wss://relay.example.com:8443");
    REQUIRE(request.code);
    CHECK(*request.code == "7KQ2M9XA");
}

TEST_CASE("every key is optional")
{
    const t3::ProvisionRequest relayOnly = accepted(R"({"relay":"relay.example.com"})");
    CHECK_FALSE(relayOnly.wifi);
    CHECK_FALSE(relayOnly.code);
    CHECK(relayOnly.relay->https == "https://relay.example.com");

    const t3::ProvisionRequest codeOnly = accepted(R"({"code":"ABCD1234"})");
    CHECK_FALSE(codeOnly.wifi);
    CHECK_FALSE(codeOnly.relay);
    CHECK(*codeOnly.code == "ABCD1234");
}

TEST_CASE("an empty frame sets nothing and says so")
{
    CHECK(refused("{}") == "provision: nothing to set");
}

TEST_CASE("relay and code are trimmed, ssid and password are byte-exact")
{
    const t3::ProvisionRequest request =
        accepted(R"({"wifi":{"ssid":" Café wifi 5G ","password":" pass word "},"relay":"  relay.example.com:8443 \n","code":"\t7kq2m9xa "})");
    CHECK(request.wifi->ssid == " Café wifi 5G ");
    CHECK(request.wifi->password == " pass word ");
    CHECK(request.relay->https == "https://relay.example.com:8443");
    CHECK(*request.code == "7KQ2M9XA");
}

TEST_CASE("a utf-8 ssid with spaces is kept byte-exact")
{
    CHECK(accepted(wifiFrame("Café wifi 5G", "password")).wifi->ssid == "Caf\xc3\xa9 wifi 5G");
}

TEST_CASE("wifi password lengths")
{
    CHECK(accepted(wifiFrame("home", std::string(64, 'a'))).wifi->password == std::string(64, 'a'));
    CHECK(accepted(wifiFrame("home", std::string(63, 'x'))).wifi->password.size() == 63);
    CHECK(accepted(wifiFrame("home", std::string(8, 'x'))).wifi->password.size() == 8);
    CHECK(refused(wifiFrame("home", "1234567")) == "wifi password: 8-63 chars or empty for an open network, got 7");
    CHECK(refused(wifiFrame("home", std::string(65, 'a'))) == "wifi password: 8-63 chars or empty for an open network, got 65");
    CHECK(refused(wifiFrame("home", std::string(64, 'x'))) == "wifi password: 64 chars is a raw psk and must be hex digits");
}

TEST_CASE("an empty password is an open network")
{
    const t3::ProvisionRequest request = accepted(wifiFrame("cafe", ""));
    CHECK(request.wifi->ssid == "cafe");
    CHECK(request.wifi->password.empty());
}

TEST_CASE("ssid budget")
{
    CHECK(refused(wifiFrame(std::string(33, 's'), "password")) == "wifi_ssid_max=32, ssid needed 33");
    CHECK(accepted(wifiFrame(std::string(32, 's'), "password")).wifi->ssid.size() == 32);
    CHECK(refused(wifiFrame("", "password")) == "wifi ssid: empty");
}

TEST_CASE("pair code is 8 letters or digits after uppercasing")
{
    CHECK(refused(R"({"code":"ABC123"})") == "pair code: 8 letters or digits, got 6");
    CHECK(refused(R"({"code":"ABCD12345"})") == "pair code: 8 letters or digits, got 9");
    CHECK(refused(R"({"code":"ABCD-123"})") == "pair code: 8 letters or digits, got 8");
    CHECK(refused(R"({"code":""})") == "pair code: 8 letters or digits, got 0");
}

TEST_CASE("a bad relay url names the problem")
{
    CHECK(refused(R"({"relay":"http://relay.example.com"})") == "relay url must be https:// or wss://");
}

TEST_CASE("an unknown key is named")
{
    CHECK(refused(R"({"relay":"relay.example.com","token":"x"})") == "provision: unknown key 'token'");
    CHECK(refused(R"({"wifi":{"ssid":"home","password":"","hidden":true}})") == "provision: unknown key 'wifi.hidden'");
}

TEST_CASE("wrong shapes are refused by name")
{
    CHECK(refused("[]") == "provision: expected a json object");
    CHECK(refused(R"({"relay":1})") == "provision: relay must be a string");
    CHECK(refused(R"({"code":null})") == "provision: code must be a string");
    CHECK(refused(R"({"wifi":"home"})") == "provision: wifi must be an object");
    CHECK(refused(R"({"wifi":{"password":"password"}})") == "provision: wifi.ssid must be a string");
    CHECK(refused(R"({"wifi":{"ssid":"home"}})") == "provision: wifi.password must be a string");
    CHECK(refused(R"({"relay":)") == "provision: not valid json at byte 8");
}

TEST_CASE("nesting past the json limit names the budget")
{
    const std::string deep = R"({"wifi":)" + std::string(40, '[') + std::string(40, ']') + "}";
    CHECK(refused(deep) == "json_nesting_max=32, frame needed 41");
}

TEST_CASE("encodeInfo is the exact wire json")
{
    CHECK(t3::encodeInfo({"v1.2.0", true, false, 3}) == R"({"fw":"v1.2.0","protocol":1,"relaySet":true,"paired":false,"wifiSaved":3})");
    CHECK(t3::encodeInfo({"a\"b\\c", false, true, 0}) == R"({"fw":"a\"b\\c","protocol":1,"relaySet":false,"paired":true,"wifiSaved":0})");
}

TEST_CASE("encodeInfo carries only the five public fields")
{
    struct JsonDeleter {
        void operator()(cJSON *json) const { cJSON_Delete(json); }
    };
    const std::unique_ptr<cJSON, JsonDeleter> json(cJSON_Parse(t3::encodeInfo({"fw", true, true, 8}).c_str()));
    REQUIRE(json);
    std::set<std::string> keys;
    for (const cJSON *item = json->child; item != nullptr; item = item->next) {
        keys.insert(item->string);
    }
    CHECK(keys == std::set<std::string>{"fw", "protocol", "relaySet", "paired", "wifiSaved"});
}
