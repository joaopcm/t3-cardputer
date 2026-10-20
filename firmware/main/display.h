#pragma once

#include <cstddef>
#include <cstdint>

#include "t3/grid.h"

bool display_init();
void display_draw(const t3::Grid &grid);

struct DisplayBuffer {
    const uint8_t *data;
    int width;
    int height;
    int bpp;
    size_t rowBytes;
};

DisplayBuffer display_buffer();
