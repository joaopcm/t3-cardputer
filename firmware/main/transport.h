#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include "freertos/FreeRTOS.h"

struct TransportEvent {
    enum class Kind { Open, Text, Close };
    Kind kind;
    int closeCode = 0;
    std::string_view text;
};

bool transport_init(const std::string &relayUrl, size_t maxFrameBytes);
bool transport_connect();
void transport_close();
std::optional<std::string> transport_send(std::string_view text);
struct AudioSendError {
    enum class Kind { NotConnected, Stalled };
    Kind kind;
    std::string text;
};

std::optional<AudioSendError> transport_send_audio(const int16_t *samples, size_t count, uint32_t waitMs);
std::optional<TransportEvent> transport_poll();
std::optional<std::string> transport_dropped();
void transport_wait(TickType_t ticks);

struct PairDone {
    int status = 0;
    std::string body;
    std::string error;
};

std::optional<std::string> pair_start(std::string body);
std::optional<PairDone> pair_poll();
