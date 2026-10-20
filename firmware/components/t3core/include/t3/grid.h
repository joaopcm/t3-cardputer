#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace t3 {

enum class Color : uint8_t { Text, Dim, Warn, Run, Ok, Red, Hdr, SelBg, BarBg };

struct Cell {
    char ch;
    Color fg;
    bool sel;
};

class Grid {
public:
    static constexpr int Cols = 40, Rows = 11;

    Grid() { clear(); }
    void clear();
    void put(int row, int col, std::string_view text, Color fg = Color::Text);
    void selectRow(int row);
    std::string rowText(int row) const;
    const Cell &at(int row, int col) const;

private:
    Cell cells_[Rows][Cols];
};

}
