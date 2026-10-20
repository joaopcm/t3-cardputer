idf_component_register(
    SRCS "grid.cpp" "protocol.cpp" "link.cpp"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES json
)
