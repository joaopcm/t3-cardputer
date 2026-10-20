idf_component_register(
    SRCS "grid.cpp" "protocol.cpp" "link.cpp" "app.cpp" "screens/home.cpp" "screens/thread.cpp" "screens/request.cpp" "screens/newtask.cpp"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "."
    PRIV_REQUIRES json
)
