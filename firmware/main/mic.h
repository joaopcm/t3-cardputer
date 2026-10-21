#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

#include "driver/i2c_master.h"

// receipt: docs/receipts/2026-10-21-firmware-voice.md "chunk", 100 ms of 16 kHz mono s16le is one 3200-byte I2S DMA buffer (cap 4092) and the simulator's chunk
inline constexpr size_t kMicChunkSamples = 1600;
inline constexpr uint32_t kMicChunkMs = 100;
// receipt: docs/receipts/2026-10-21-firmware-voice.md "dma"
inline constexpr uint32_t kMicDmaChunks = 4;
inline constexpr uint32_t kMicBufferMs = (kMicDmaChunks - 1) * kMicChunkMs;

bool mic_init(i2c_master_bus_handle_t bus);
void mic_power_up();
void mic_power_down();
void mic_tick();
std::optional<std::string> mic_start();
size_t mic_read(int16_t *buf, size_t n, uint32_t waitMs = 0);
void mic_stop();
std::optional<std::string> mic_lost();
