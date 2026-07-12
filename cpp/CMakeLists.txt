cmake_minimum_required(VERSION 3.20)
project(1inkulous_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Emscripten build (future):
#   emcmake cmake -B build-wasm -S cpp
#   cmake --build build-wasm
#
# Output .wasm and glue .js should land in public/ for Vite to serve.

add_library(1inkulous_core STATIC
  src/placeholder.cpp
)

target_include_directories(1inkulous_core PUBLIC include)
