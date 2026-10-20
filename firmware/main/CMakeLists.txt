set(srcs "app_main.cpp" "display.cpp")
if(CONFIG_T3_DEBUG_SERIAL)
    list(APPEND srcs "debug_serial.cpp")
endif()

idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS "."
    REQUIRES driver esp_driver_usb_serial_jtag esp_timer t3core
)

target_compile_definitions(${COMPONENT_LIB} PRIVATE T3_RELAY_URL="${T3_RELAY_URL}")
