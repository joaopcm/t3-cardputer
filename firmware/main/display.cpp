#include "display.h"

#include "esp_heap_caps.h"
#include "esp_log.h"

#define M5GFX_BOARD lgfx::boards::board_M5CardputerADV
#include <M5GFX.h>

namespace {

constexpr char TAG[] = "display";

constexpr int kWidth = 240;
constexpr int kHeight = 135;
// receipt: sprite 16200 bytes, docs/receipts/2026-10-21-firmware-baseline.md
constexpr int kBpp = 4;
constexpr int kCellW = 6;
constexpr int kCellH = 12;
constexpr int kGlyphTop = 2;
constexpr int kLastRow = t3::Grid::Rows - 1;
constexpr int kBottomBarY = kHeight - kCellH;

static_assert(kCellW * t3::Grid::Cols == kWidth);
static_assert(kCellH * t3::Grid::Rows <= kHeight);

constexpr uint8_t kBlack = static_cast<uint8_t>(t3::Color::BarBg) + 1;

struct PaletteEntry {
    uint8_t index;
    uint32_t rgb;
};

constexpr PaletteEntry kPalette[] = {
    {static_cast<uint8_t>(t3::Color::Text), 0xd8d8d8},
    {static_cast<uint8_t>(t3::Color::Dim), 0x6b6b6b},
    {static_cast<uint8_t>(t3::Color::Warn), 0xffb020},
    {static_cast<uint8_t>(t3::Color::Run), 0x4fc3f7},
    {static_cast<uint8_t>(t3::Color::Ok), 0x7bd88f},
    {static_cast<uint8_t>(t3::Color::Red), 0xff6b6b},
    {static_cast<uint8_t>(t3::Color::Hdr), 0xffffff},
    {static_cast<uint8_t>(t3::Color::SelBg), 0x2d4a7a},
    {static_cast<uint8_t>(t3::Color::BarBg), 0x1a1a1a},
    {kBlack, 0x000000},
};

M5GFX panel;
M5Canvas canvas(&panel);

int rowY(int row)
{
    return row == kLastRow ? kBottomBarY : row * kCellH;
}

bool isBar(int row)
{
    return row == 0 || row == kLastRow;
}

}

bool display_init()
{
    panel.init();
    panel.setRotation(1);
    panel.fillScreen(TFT_BLACK);

    canvas.setColorDepth(kBpp);
    if (canvas.createSprite(kWidth, kHeight) == nullptr) {
        ESP_LOGE(TAG, "sprite_bytes=%d, alloc failed, largest_block=%u", kWidth * kHeight * kBpp / 8,
                 static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)));
        return false;
    }
    for (const PaletteEntry &entry : kPalette) {
        canvas.setPaletteColor(entry.index, entry.rgb >> 16, (entry.rgb >> 8) & 0xff, entry.rgb & 0xff);
    }
    canvas.setFont(&fonts::Font0);
    canvas.setTextSize(1);
    return true;
}

void display_draw(const t3::Grid &grid)
{
    canvas.fillScreen(kBlack);
    for (int row = 0; row < t3::Grid::Rows; ++row) {
        const int y = rowY(row);
        canvas.fillRect(0, y, kWidth, kCellH, isBar(row) ? static_cast<uint8_t>(t3::Color::BarBg) : kBlack);
        for (int col = 0; col < t3::Grid::Cols; ++col) {
            const t3::Cell &cell = grid.at(row, col);
            const int x = col * kCellW;
            if (cell.sel) {
                canvas.fillRect(x, y, kCellW, kCellH, static_cast<uint8_t>(t3::Color::SelBg));
            }
            if (cell.ch != ' ') {
                canvas.setTextColor(static_cast<uint8_t>(cell.fg));
                canvas.drawChar(cell.ch, x, y + kGlyphTop);
            }
        }
    }
    canvas.pushSprite(0, 0);
}

DisplayBuffer display_buffer()
{
    return {static_cast<const uint8_t *>(canvas.getBuffer()), kWidth, kHeight, kBpp,
            static_cast<size_t>((kWidth * kBpp + 7) / 8)};
}
