#pragma once

#include <string_view>

namespace t3 {

void installJsonHooks();
int jsonNestingDepth(std::string_view json);

}
