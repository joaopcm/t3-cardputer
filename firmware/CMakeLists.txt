cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/local.cmake")
    message(FATAL_ERROR "firmware/local.cmake missing: copy local.cmake.example and set T3_RELAY_URL")
endif()
include("${CMAKE_CURRENT_LIST_DIR}/local.cmake")
if(NOT T3_RELAY_URL)
    message(FATAL_ERROR "T3_RELAY_URL empty in firmware/local.cmake")
endif()
string(REGEX REPLACE "^https://" "wss://" T3_RELAY_URL "${T3_RELAY_URL}")
if(NOT T3_RELAY_URL MATCHES "^wss://.")
    message(FATAL_ERROR "T3_RELAY_URL in firmware/local.cmake must start with wss:// or https://")
endif()

project(t3_cardputer)
