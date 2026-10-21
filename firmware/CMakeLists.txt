cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

idf_build_set_property(COMPILE_DEFINITIONS "CJSON_NESTING_LIMIT=32" APPEND)

project(t3_cardputer)
