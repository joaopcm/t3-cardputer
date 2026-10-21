cmake_minimum_required(VERSION 3.16)
project(t3_firmware_host LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

enable_testing()

add_library(cjson STATIC third_party/cJSON.c)
target_include_directories(cjson PUBLIC third_party)
target_compile_definitions(cjson PUBLIC CJSON_NESTING_LIMIT=32)

set(T3CORE_DIR ${CMAKE_CURRENT_LIST_DIR}/../../components/t3core)
add_library(t3core STATIC ${T3CORE_DIR}/grid.cpp ${T3CORE_DIR}/protocol.cpp ${T3CORE_DIR}/link.cpp ${T3CORE_DIR}/app.cpp ${T3CORE_DIR}/screens/home.cpp ${T3CORE_DIR}/screens/thread.cpp ${T3CORE_DIR}/screens/request.cpp ${T3CORE_DIR}/screens/newtask.cpp ${T3CORE_DIR}/screens/setup.cpp ${T3CORE_DIR}/screens/voice.cpp ${T3CORE_DIR}/keymap.cpp ${T3CORE_DIR}/power.cpp ${T3CORE_DIR}/wifi_pick.cpp)
target_include_directories(t3core PUBLIC ${T3CORE_DIR}/include PRIVATE ${T3CORE_DIR})
target_link_libraries(t3core PRIVATE cjson)
target_compile_options(t3core PRIVATE -Wall -Wextra)

add_executable(host_tests main.cpp grid_test.cpp keys_test.cpp protocol_test.cpp link_test.cpp doc_examples_test.cpp app_test.cpp setup_test.cpp keymap_test.cpp power_test.cpp voice_test.cpp wifi_pick_test.cpp)
target_compile_definitions(host_tests PRIVATE T3_REPO_ROOT="${CMAKE_CURRENT_LIST_DIR}/../../..")
target_include_directories(host_tests PRIVATE third_party)
target_link_libraries(host_tests PRIVATE cjson t3core)
target_compile_options(host_tests PRIVATE -Wall -Wextra)

add_test(NAME host_tests COMMAND host_tests)
