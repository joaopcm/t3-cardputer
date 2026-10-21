#include "doctest.h"

#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <string>

#include "cJSON.h"
#include "t3/grid.h"
#include "t3/protocol.h"
#include "t3/provision.h"

namespace {

// receipt: firmware/main/app_main.cpp kCaps, the caps the device says hello with
const t3::HelloCaps kDeviceCaps{t3::Grid::Cols, 7, 8192, 32};
// why: firmware/main/debug_serial.cpp reads `\x02FRAME <json>` into the serial line buffer, kProvisionLineMax bytes
constexpr std::string_view kFramePrefix = "FRAME ";

std::string readFile(const std::filesystem::path &path)
{
    std::ifstream in(path);
    REQUIRE(in.good());
    std::stringstream text;
    text << in.rdbuf();
    return text.str();
}

}

TEST_CASE("every screenshot fixture is one relay frame the device accepts over FRAME")
{
    const std::filesystem::path dir = std::filesystem::path(T3_REPO_ROOT) / "docs/images/fixtures";
    REQUIRE(std::filesystem::is_directory(dir));
    std::set<std::string> types;
    for (const auto &entry : std::filesystem::directory_iterator(dir)) {
        if (entry.path().extension() != ".json") {
            continue;
        }
        const std::string text = readFile(entry.path());
        INFO(entry.path().filename().string());
        cJSON *json = cJSON_Parse(text.c_str());
        REQUIRE(json != nullptr);
        char *compact = cJSON_PrintUnformatted(json);
        const std::string frame(compact);
        cJSON_free(compact);
        cJSON_Delete(json);
        std::string err;
        REQUIRE_MESSAGE(t3::parseRelay(frame, kDeviceCaps, err).has_value(), err);
        CHECK_MESSAGE(kFramePrefix.size() + frame.size() <= t3::kProvisionLineMax,
                      "provision_line_max=" << t3::kProvisionLineMax << ", FRAME line needed " << kFramePrefix.size() + frame.size());
        const size_t at = frame.find("\"type\":\"") + 8;
        types.insert(frame.substr(at, frame.find('"', at) - at));
    }
    for (const char *type : {"home", "thread_page", "request", "projects", "transcript_partial"}) {
        CHECK_MESSAGE(types.count(type) == 1, "docs/images/fixtures has no " << type << " frame");
    }
}
