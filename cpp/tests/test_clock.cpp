// The fixed-step clock: the renderer's frame time goes in, whole steps come out.

#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>

#include <doctest/doctest.h>

#include "1inkulous/core.hpp"

using inkulous::Simulation;

TEST_CASE("the version is encoded and spelled the same way") {
  CHECK(inkulous::core_version() == inkulous::kVersion);
  CHECK(inkulous::kVersion ==
        inkulous::kVersionMajor * 10000 + inkulous::kVersionMinor * 100 + inkulous::kVersionPatch);
  char expected[32];
  std::snprintf(expected, sizeof expected, "%d.%d.%d", inkulous::kVersionMajor,
                inkulous::kVersionMinor, inkulous::kVersionPatch);
  CHECK(std::strcmp(inkulous::core_version_string(), expected) == 0);
}

TEST_CASE("the default step is 50ms, and nonsense steps fall back to it") {
  CHECK(Simulation{}.step_ms() == 50.0);
  CHECK(Simulation{0.0}.step_ms() == inkulous::kDefaultStepMs);
  CHECK(Simulation{-5.0}.step_ms() == inkulous::kDefaultStepMs);
  CHECK(Simulation{10.0}.step_ms() == 10.0);
}

TEST_CASE("a frame shorter than a step runs nothing but is remembered") {
  Simulation sim;
  CHECK(sim.advance(16.7) == 0);
  CHECK(sim.pending_ms() == doctest::Approx(16.7));
  CHECK(sim.advance(16.7) == 0);
  // Three 16.7ms frames are 50.1ms: exactly one step, with 0.1ms carried.
  CHECK(sim.advance(16.7) == 1);
  CHECK(sim.step_count() == 1);
  CHECK(sim.elapsed_ms() == 50.0);
  CHECK(sim.pending_ms() == doctest::Approx(0.1));
}

TEST_CASE("a long frame runs several steps and carries the remainder") {
  Simulation sim;
  CHECK(sim.advance(220.0) == 4);
  CHECK(sim.pending_ms() == doctest::Approx(20.0));
  CHECK(sim.step_count() == 4);
}

TEST_CASE("a stall is capped instead of replayed") {
  Simulation sim;
  // 250ms of a 60s stall: five steps.
  CHECK(sim.advance(60'000.0) == 5);
  CHECK(sim.advance(std::numeric_limits<double>::infinity()) == 5);
}

TEST_CASE("garbage frame times are ignored") {
  Simulation sim;
  CHECK(sim.advance(-100.0) == 0);
  CHECK(sim.advance(std::numeric_limits<double>::quiet_NaN()) == 0);
  CHECK(sim.advance(0.0) == 0);
  CHECK(sim.pending_ms() == 0.0);
  CHECK(sim.step_count() == 0);
}

TEST_CASE("ten seconds at 60fps is 200 steps, however the frames fall") {
  Simulation sim;
  std::int32_t steps = 0;
  for (int frame = 0; frame < 600; ++frame) steps += sim.advance(1000.0 / 60.0);
  CHECK(steps == 200);
  CHECK(sim.elapsed_ms() == doctest::Approx(10'000.0));
}

TEST_CASE("changing the step, or resetting, clears the clock") {
  Simulation sim;
  sim.advance(120.0);
  REQUIRE(sim.step_count() == 2);
  sim.reset();
  CHECK(sim.step_count() == 0);
  CHECK(sim.pending_ms() == 0.0);

  sim.advance(120.0);
  sim.set_step_ms(10.0);
  CHECK(sim.step_ms() == 10.0);
  CHECK(sim.step_count() == 0);
  CHECK(sim.advance(100.0) == 10);
}
