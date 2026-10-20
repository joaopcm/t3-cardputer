cmake_minimum_required(VERSION 3.16)
project(t3_firmware_host LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

enable_testing()

add_library(cjson STATIC third_party/cJSON.c)
target_include_directories(cjson PUBLIC third_party)

add_executable(host_tests main.cpp)
target_include_directories(host_tests PRIVATE third_party)
target_link_libraries(host_tests PRIVATE cjson)
target_compile_options(host_tests PRIVATE -Wall -Wextra)

add_test(NAME host_tests COMMAND host_tests)
