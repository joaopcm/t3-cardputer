#include "power.h"

#include <optional>

#include "display.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"

namespace {

constexpr char TAG[] = "power";

// estimate, retune from a real measurement: docs/receipts/2026-10-21-firmware-power.md "timeouts"; a forgotten lit device costs 0.29 to 1.3 mAh before it goes dark
constexpr uint32_t kDimAfterMs = 30000;
// estimate, retune from a real measurement: docs/receipts/2026-10-21-firmware-power.md "timeouts"; screen off cuts the draw from 70 to 132 mA to about 45 mA
constexpr uint32_t kOffAfterMs = 60000;

// receipt: M5Unified 0.2.27 Power_Class.inl, board_M5CardputerADV reads the battery on GPIO10 through a divider of 2.0
constexpr int kBatteryGpio = 10;
constexpr int kBatteryDivider = 2;
// receipt: M5Unified 0.2.27 Power_Class.inl getBatteryLevel computes (mv - 3300) * 100 / (4150 - 3350), so the span is 800 mV and 100% is 4100 mV
constexpr int kEmptyMv = 3300;
constexpr int kSpanMv = 4150 - 3350;

t3::Power power(kDimAfterMs, kOffAfterMs, 0);
adc_oneshot_unit_handle_t adc;
adc_cali_handle_t calibration;
adc_channel_t channel;

const char *levelName(t3::Power::Level level)
{
    switch (level) {
    case t3::Power::Level::Full:
        return "full";
    case t3::Power::Level::Dim:
        return "dim";
    case t3::Power::Level::Off:
        return "off";
    }
    return "";
}

DisplayLevel displayLevel(t3::Power::Level level)
{
    switch (level) {
    case t3::Power::Level::Full:
        return DisplayLevel::Full;
    case t3::Power::Level::Dim:
        return DisplayLevel::Dim;
    case t3::Power::Level::Off:
        return DisplayLevel::Off;
    }
    return DisplayLevel::Full;
}

bool batteryInit()
{
    adc_unit_t unit;
    if (adc_oneshot_io_to_channel(kBatteryGpio, &unit, &channel) != ESP_OK) {
        return false;
    }
    const adc_oneshot_unit_init_cfg_t unitConfig = {.unit_id = unit, .clk_src = ADC_RTC_CLK_SRC_DEFAULT, .ulp_mode = ADC_ULP_MODE_DISABLE};
    const adc_oneshot_chan_cfg_t channelConfig = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    if (adc_oneshot_new_unit(&unitConfig, &adc) != ESP_OK || adc_oneshot_config_channel(adc, channel, &channelConfig) != ESP_OK) {
        return false;
    }
    const adc_cali_curve_fitting_config_t caliConfig = {
        .unit_id = unit, .chan = channel, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
    return adc_cali_create_scheme_curve_fitting(&caliConfig, &calibration) == ESP_OK;
}

std::optional<int> batteryMv()
{
    int raw;
    int mv;
    if (adc == nullptr || adc_oneshot_read(adc, channel, &raw) != ESP_OK || adc_cali_raw_to_voltage(calibration, raw, &mv) != ESP_OK) {
        return std::nullopt;
    }
    return mv * kBatteryDivider;
}

void logBattery(const char *when)
{
    const std::optional<int> mv = batteryMv();
    if (!mv) {
        ESP_LOGW(TAG, "%s battery unreadable", when);
        return;
    }
    const int percent = (*mv - kEmptyMv) * 100 / kSpanMv;
    ESP_LOGI(TAG, "%s battery %d%% %d mV", when, percent < 0 ? 0 : (percent > 100 ? 100 : percent), *mv);
}

void applyLevel(t3::Power::Level level)
{
    display_set_level(displayLevel(level));
    ESP_LOGI(TAG, "screen %s", levelName(level));
    logBattery(levelName(level));
}

}

void power_init(uint32_t nowMs)
{
    if (!batteryInit()) {
        ESP_LOGW(TAG, "battery adc init failed, gpio=%d", kBatteryGpio);
    }
    power.setTimeouts(kDimAfterMs, kOffAfterMs, nowMs);
    logBattery("boot");
}

t3::Power::KeyEffect power_on_key(uint32_t nowMs)
{
    const t3::Power::Level before = power.level();
    const t3::Power::KeyEffect effect = power.onKey(nowMs);
    if (before != t3::Power::Level::Full) {
        applyLevel(power.level());
    }
    return effect;
}

void power_tick(uint32_t nowMs, bool editing)
{
    power.setEditing(editing);
    if (power.onTick(nowMs)) {
        applyLevel(power.level());
    }
}

void power_set_timeouts(uint32_t dimAfterMs, uint32_t offAfterMs, uint32_t nowMs)
{
    ESP_LOGI(TAG, "debug: dim_after_ms=%u off_after_ms=%u", static_cast<unsigned>(dimAfterMs), static_cast<unsigned>(offAfterMs));
    power.setTimeouts(dimAfterMs, offAfterMs, nowMs);
    display_set_level(DisplayLevel::Full);
}

t3::Power::Level power_level()
{
    return power.level();
}
