#include "t3/grid.h"

namespace t3 {

namespace {

constexpr Cell kBlank{' ', Color::Text, false};

bool validRow(int row)
{
    return row >= 0 && row < Grid::Rows;
}

char printable(char c)
{
    return c >= 0x20 && c <= 0x7e ? c : '?';
}

}

void Grid::clear()
{
    for (Cell(&row)[Cols] : cells_) {
        for (Cell &cell : row) {
            cell = kBlank;
        }
    }
}

void Grid::put(int row, int col, std::string_view text, Color fg)
{
    if (!validRow(row)) {
        return;
    }
    for (char c : text) {
        if (col >= Cols) {
            return;
        }
        if (col >= 0) {
            Cell &cell = cells_[row][col];
            cell.ch = printable(c);
            cell.fg = fg;
        }
        ++col;
    }
}

void Grid::selectRow(int row)
{
    if (!validRow(row)) {
        return;
    }
    for (Cell &cell : cells_[row]) {
        cell.sel = true;
    }
}

std::string Grid::rowText(int row) const
{
    std::string text(Cols, ' ');
    if (!validRow(row)) {
        return text;
    }
    for (int col = 0; col < Cols; ++col) {
        text[col] = cells_[row][col].ch;
    }
    return text;
}

const Cell &Grid::at(int row, int col) const
{
    if (!validRow(row) || col < 0 || col >= Cols) {
        return kBlank;
    }
    return cells_[row][col];
}

}
