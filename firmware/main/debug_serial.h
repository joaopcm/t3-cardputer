#pragma once

#include "sdkconfig.h"
#include "t3/keys.h"

#ifdef CONFIG_T3_DEBUG_SERIAL

bool debug_serial_start();
bool debug_serial_poll_key(t3::Key *key);
bool debug_serial_poll_drop();

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

#endif
