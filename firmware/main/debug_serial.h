#pragma once

#include <cstdint>

#include "sdkconfig.h"
#include "t3/keys.h"

enum class DebugNetCut { None, LeaveAp, BlackHole, Restore };

#ifdef CONFIG_T3_DEBUG_SERIAL

bool debug_serial_start();
bool debug_serial_poll_key(t3::Key *key);
bool debug_serial_poll_drop();
DebugNetCut debug_serial_poll_net_cut();
bool debug_serial_poll_power(uint32_t *dimAfterMs, uint32_t *offAfterMs);

#else

inline bool debug_serial_start()
{
    return true;
}

inline bool debug_serial_poll_key(t3::Key *)
{
    return false;
}

inline bool debug_serial_poll_drop()
{
    return false;
}

inline DebugNetCut debug_serial_poll_net_cut()
{
    return DebugNetCut::None;
}

inline bool debug_serial_poll_power(uint32_t *, uint32_t *)
{
    return false;
}

#endif
