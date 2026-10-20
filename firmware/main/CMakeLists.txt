set(srcs "app_main.cpp" "display.cpp" "keyboard.cpp" "settings.cpp" "transport.cpp" "wifi.cpp")
if(CONFIG_T3_DEBUG_SERIAL)
    list(APPEND srcs "debug_serial.cpp")
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS "."
    REQUIRES driver esp_app_format esp_driver_i2c esp_driver_usb_serial_jtag esp_event esp_http_client esp_netif esp_timer esp_websocket_client esp_wifi json mbedtls nvs_flash t3core
)

target_compile_definitions(${COMPONENT_LIB} PRIVATE T3_RELAY_URL="${T3_RELAY_URL}")
