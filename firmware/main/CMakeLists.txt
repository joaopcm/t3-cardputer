idf_component_register(
    SRCS "app_main.cpp"
    INCLUDE_DIRS "."
    REQUIRES M5GFX M5Unified driver esp_timer
)

target_compile_definitions(${COMPONENT_LIB} PRIVATE T3_RELAY_URL="${T3_RELAY_URL}")
