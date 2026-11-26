# Native unit tests for the simulation core: doctest, run by ctest.
#
#   cmake --preset native-debug && cmake --build --preset native-debug
#   ctest --preset native-debug
#
# The same sources run under AddressSanitizer and UBSan with the native-asan
# preset; CI does both. The WebAssembly build does not build these.

include(FetchContent)

# One header, no dependencies. Pinned to a release tag, so a new doctest cannot
# change what CI means overnight. Only fetched, never add_subdirectory()'d:
# SOURCE_SUBDIR points at the header directory, which has no CMakeLists.txt, so
# doctest's own build files (which CMake 4 refuses for their ancient minimum
# version) are not read. Override with
# -DFETCHCONTENT_SOURCE_DIR_DOCTEST=/path/to/doctest to work offline.
FetchContent_Declare(
  doctest
  GIT_REPOSITORY https://github.com/doctest/doctest.git
  GIT_TAG v2.4.11
  GIT_SHALLOW TRUE
  SOURCE_SUBDIR doctest
)
FetchContent_MakeAvailable(doctest)

add_executable(core_tests
  main.cpp
  test_abi.cpp
  test_ai.cpp
  test_clock.cpp
  test_combat.cpp
  test_determinism.cpp
  test_economy.cpp
  test_followers.cpp
  test_huts.cpp
  test_nav.cpp
  test_shaman.cpp
  test_terrain.cpp
  test_worlds.cpp
)

target_link_libraries(core_tests PRIVATE 1inkulous_core)
target_include_directories(core_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
# doctest as a system include: its own headers are not held to our warnings.
target_include_directories(core_tests SYSTEM PRIVATE "${doctest_SOURCE_DIR}")

# Only the core is built without exceptions and RTTI (that is what ships to
# WebAssembly, and these tests link the very same objects). The tests keep
# exceptions on: doctest's REQUIRE ends a failed case by throwing, and without
# that the case would carry on past a failed `REQUIRE(id >= 0)` into an
# out-of-range read. doctest also supports -fno-exceptions
# (DOCTEST_CONFIG_NO_EXCEPTIONS_BUT_WITH_ALL_ASSERTS), where REQUIRE only
# reports, if that is ever wanted.
if(NOT MSVC)
  target_compile_options(core_tests PRIVATE -Wall -Wextra)
endif()

# One ctest entry for the whole binary; `core_tests -tc=<pattern>` runs a subset
# and `ctest --output-on-failure` shows doctest's report for the case that broke.
add_test(NAME core_tests COMMAND core_tests)
set_tests_properties(core_tests PROPERTIES TIMEOUT 300)

if(CORE_SANITIZE)
  # Leaks are on by default on Linux; the rest are the stricter options worth
  # having here. Set on the test rather than in a preset so `ctest` and a direct
  # run of the binary under the same environment agree.
  set_tests_properties(core_tests PROPERTIES ENVIRONMENT
    "ASAN_OPTIONS=detect_leaks=1:strict_string_checks=1:check_initialization_order=1;UBSAN_OPTIONS=print_stacktrace=1")
endif()
