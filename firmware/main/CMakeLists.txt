idf_component_register(
    SRCS "app_main.cpp" "display.cpp" "debug_serial.cpp"
    INCLUDE_DIRS "."
    REQUIRES driver esp_driver_usb_serial_jtag esp_timer t3core
)

target_compile_definitions(${COMPONENT_LIB} PRIVATE T3_RELAY_URL="${T3_RELAY_URL}")
