#pragma once

#include <cstddef>
#include <cstdint>

#include "t3/grid.h"

enum class DisplayLevel { Full, Dim, Off };

bool display_init();
void display_set_level(DisplayLevel level);
void display_draw(const t3::Grid &grid);

struct DisplayBuffer {
    const uint8_t *data;
    int width;
    int height;
    int bpp;
    size_t rowBytes;
};

using DisplayBufferFn = void (*)(const DisplayBuffer &buffer, void *context);

void display_with_buffer(DisplayBufferFn fn, void *context);
