# Power: dim, sleep and wake timeouts (estimates)

Everything below is an ESTIMATE from published figures. No battery drain was measured on the ADV for this task (João's decision, 2026-10-20). The timeouts in `firmware/main/power.cpp` and the dim ratio in `firmware/main/display.cpp` are marked "estimate, retune from a real measurement": replace them with a measured discharge run (screen on, dimmed, screen off, same WiFi) when one exists.

## inputs

| input | value | source |
| --- | --- | --- |
| ADV battery capacity | 1500 mAh. The page's version log reads "Battery capacity changed from 1750mAh to 1500mAh" (2026.7.13), so older units and retailer pages say 1750 mAh. Sized on 1500, the lower | https://docs.m5stack.com/en/core/Cardputer-Adv (older figure: https://evelta.com/m5stack-cardputer-adv-esp32-s3-programmable-platform-for-embedded-prototyping-iot-development/) |
| ADV operating current | 120.2 mA, WiFi operating 132.3 mA, both "DC4.2V@" (taken at the battery side, screen on, radio and CPU working) | same M5 page |
| usable fraction | 80% of rated: the firmware's battery map starts at 3300 mV (0%) and the boost and regulators lose a few percent. Assumption, no source | M5Unified 0.2.27 `Power_Class.inl` for the voltage map |
| usable capacity | 1500 x 0.8 = 1200 mAh | arithmetic |
| ESP32-S3 modem-sleep, 160 MHz, DFS off | 40.1 mA average at DTIM1 (38.7 DTIM3, 38.2 DTIM10), SoC only, shielded box | https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-guides/low-power-mode/low-power-mode-wifi.html |
| ESP32-S3 CPU idle, 160 MHz, WiFi clock gated | 27.6 mA (peripheral clocks off) to 42.3 mA (peripheral clocks on); light sleep 240 uA; flash access in modem-sleep adds 10 mA | ESP32-S3 datasheet v2.2 tables 5-9 and 5-10, https://documentation.espressif.com/esp32-s3_datasheet_en.pdf |
| ESP32-S3 auto light sleep with WiFi | 2.45 mA (DTIM1), 1.33 mA (DTIM3), 0.93 mA (DTIM10), average, SoC only | the ESP-IDF page above |
| ST7789 backlight | at most 20 mA: a retailer lists "operating current 20mA" for the 1.14" module and does not say whether that is the backlight alone. Taken as the upper bound for the backlight. M5 publishes no backlight figure | https://openelab.io/de/products/1-14-inch-tft-screen |
| board overhead with the screen dark | 5 mA: flash, TCA8418 keyboard controller, regulators, panel in sleep-in. Assumption, no source | none |
| our WiFi power save | `pm start, type: 1` in the boot log: no `esp_wifi_set_ps` call in `wifi.cpp`, so ESP-IDF's default `WIFI_PS_MIN_MODEM`; `CONFIG_PM_ENABLE` is off, CPU fixed at 160 MHz | ADV boot log, `firmware/sdkconfig` |
| AP beacon | DTIM period 1, beacon interval 102.4 ms, listen interval 3 | the same boot log |

## runtime estimates (1200 mAh usable)

| state | current | runtime | arithmetic |
| --- | --- | --- | --- |
| screen on, connected, worst case (M5's WiFi operating figure) | 132.3 mA | 9.1 h | 1200 / 132.3 |
| screen on, connected, bottom-up idle | 45 + 20 backlight + 5 panel = 70 mA | 17 h | 1200 / 70 |
| dimmed to 1/4 backlight, connected | 70 - 15 = 55 mA (worst case 132.3 - 15 = 117.3 mA, 10.2 h) | 22 h | 1200 / 55 |
| screen off, link up (modem-sleep, shipped) | 40.1 + 5 = 45 mA | 27 h | 1200 / 45 |
| screen off, WiFi down, CPU idle at 160 MHz | (27.6 to 42.3) + 5 = 33 to 47 mA, 40 mA mid | 30 h | 1200 / 40 |
| screen off, link up, auto light sleep (NOT shipped) | 1.33 to 2.45 + 5 = 6 to 8 mA | about 170 h | 1200 / 7 |

Two findings:

- Dropping the link while the screen is dark saves about 5 mA of 45 (11%), and costs an 11.1 s reconnect on wake (`docs/receipts/2026-10-21-firmware-network.md` "connect": 7.2 s DNS + 3.8 s TLS). So the shipped design keeps the link up while the screen is off and wake sends `refresh` over it. The main spec allows the link to drop while dark; nothing here needs it to.
- The big lever is not the screen, it is the CPU running flat out at 160 MHz with no power management: screen off is 45 mA, and light sleep would be 6 to 8 mA. That needs `CONFIG_PM_ENABLE` plus auto light sleep and a check that the USB serial debug channel and the 20 ms main loop poll survive it. It is a follow-up with its own measurement, not part of this task.

## timeouts

`kDimAfterMs = 30000`, `kOffAfterMs = 60000`. Estimate, retune from a real measurement.

Why these and not shorter:

- Energy does not pick them. A lit screen costs 25 mA (bottom-up) to 87 mA (M5 figure) over a dark one. A forgotten device that runs both timeouts out costs 30 s x 25 mA + 30 s x 10 mA = 1050 mA s = 0.29 mAh bottom-up, or 30 x 87 + 30 x 72 = 4770 mA s = 1.3 mAh worst case: 0.02% to 0.09% of 1500 mAh. Twenty full timeouts a day is 6 to 26 mAh, at most 2% of a charge.
- The dim step alone saves at most 15 mA x 30 s = 0.13 mAh per cycle. It is a warning before the screen goes dark, not a saving.
- Use picks them. 30 s keeps a thread page or a typed reply lit while it is read and typed; a dimmed screen is still readable and a key acts on it. 60 s of nothing means the device was put down, and then dark is right.
- An idle device in a pocket is dark within 60 s, so it draws about 45 mA: 27 h per charge, not the 9 to 17 h of a lit one.

`kDimBrightnessDivisor = 4`: M5GFX's default full brightness on the ADV is 127 (`display: full_brightness=127` at boot), so dim is 31. Estimate: a quarter of the backlight duty is still readable indoors and saves up to 15 of the at most 20 mA. The glass was not looked at in a dark room for this; only the sprite was screenshotted.

## mic codec (ES8311)

ESTIMATE, from the datasheet; not measured on the ADV.

| input | value | source |
| --- | --- | --- |
| ES8311 normal operation | 8 mA typical at DVDD 1.8 V, PVDD 1.8 V, AVDD 3.3 V, the only operating figure in the datasheet; the front page says "14 mW playback and record". Taken as the upper bound for a powered capture path | ES8311 datasheet rev 7.0 (January 2020), "DC characteristics", https://dl.espressif.com/dl/schematics/Audio_ES8311.pdf |
| ES8311 power down | 0 uA typical | same table |
| mic bias | the ES8311 has no bias pin; the ADV's analog MEMS mic is not named in M5's docs. Typical analog MEMS mics draw about 0.1 to 0.25 mA. Assumption, and it does not change with the codec's state | none |

- Codec left powered all day: 8 mA x 24 h = 192 mAh, 16% of the 1200 mAh usable. That is far over the 3% (36 mAh) line.
- Shipped: the codec is powered down (M5Unified's disable table, then 0 uA) whenever the screen goes off, and powered up again when it wakes, with the I2S clock running 2 s to warm it (`firmware/main/mic.cpp`, `2026-10-21-firmware-voice.md` "warm-up"). While the screen is on, the codec adds at most 8 mA to the 70 to 132 mA of a lit screen. A device that is dark most of the day pays only for its lit minutes: an hour lit is 8 mAh (0.7%).

## battery level

`power.cpp` logs the battery at boot and on every screen level change: `power: boot battery 100% 4140 mV`. The reading is GPIO10 through a divider of 2.0 and the M5Unified percent formula `(mv - 3300) * 100 / (4150 - 3350)`: a span of 800 mV, so 0% at 3300 mV and 100% at 4100 mV, clamped. On the bench the ADV is on USB, so the voltage is the charger's, not a discharge reading: 4136 to 4140 mV, which the formula clamps to 100%. It becomes a drain figure once the device runs unplugged.

## not measured, to retune

- real current in each state (discharge run through `power: ... battery` lines, or a USB power meter)
- the backlight's own current at 127 and at 31
- the board overhead (the 5 mA)
- how often the relay pushes `home` while idle: the ADV log shows a `home` frame about every 2.0 to 2.2 s with nothing changing on screen. That keeps the radio busy and would defeat light sleep, so check it before turning power management on.
