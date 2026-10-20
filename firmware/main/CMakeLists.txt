set(srcs "app_main.cpp" "demo_relay.cpp" "display.cpp" "keyboard.cpp" "settings.cpp")
if(CONFIG_T3_DEBUG_SERIAL)
    list(APPEND srcs "debug_serial.cpp")
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS "."
    REQUIRES driver esp_driver_i2c esp_driver_usb_serial_jtag esp_timer json nvs_flash t3core
)

target_compile_definitions(${COMPONENT_LIB} PRIVATE T3_RELAY_URL="${T3_RELAY_URL}")
