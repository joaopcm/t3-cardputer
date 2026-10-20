#pragma once

#include <string>
#include <string_view>
#include <vector>

extern const char kDemoHome[];

std::vector<std::string> demo_relay_answer(std::string_view deviceFrame);
