// Simulation core: the fixed-step clock everything else hangs off.
//
// Determinism rules, which replays and lockstep depend on:
// - Every step runs the same systems in the same order, and commands from
//   outside only ever land between steps (the clock never stops mid-step).
// - Chance comes only from `random_`, seeded by `seed_match`.
// - No -ffast-math or any other licence to reorder floating point (see
//   CMakeLists.txt), and one wasm build of libm for sin/cos/sqrt.

#include "1inkulous/core.hpp"

namespace inkulous {
namespace {

// "0.10.0" — built by hand so the string is static storage with no allocation,
// which keeps core_version_text() safe to hand across the WASM boundary.
#define INKULOUS_STRINGIFY_(x) #x
#define INKULOUS_STRINGIFY(x) INKULOUS_STRINGIFY_(x)
constexpr const char* kVersionText =
    INKULOUS_STRINGIFY(0) "." INKULOUS_STRINGIFY(12) "." INKULOUS_STRINGIFY(0);

static_assert(kVersionMajor == 0 && kVersionMinor == 12 && kVersionPatch == 0,
              "kVersionText must be kept in step with the version constants");

}  // namespace

const char* core_version_string() { return kVersionText; }

int core_version() { return kVersion; }

Simulation::Simulation(double step_ms) : step_ms_(step_ms > 0.0 ? step_ms : kDefaultStepMs) {
  terrain_.attach(&nav_);
  followers_.set_grid(&nav_);
  huts_.attach(&nav_, &followers_, &stores_);
  trees_.attach(&nav_, &followers_, &stores_);
  shamans_.attach(&nav_, &terrain_, &followers_, &huts_);
  ai_.attach(&nav_, &followers_, &huts_, &trees_, &shamans_, &stores_);
  checkpoints_.reserve(static_cast<std::size_t>(kMaxCheckpoints));
}

void Simulation::set_step_ms(double step_ms) {
  step_ms_ = step_ms > 0.0 ? step_ms : kDefaultStepMs;
  reset();
}

std::int32_t Simulation::advance(double delta_ms) {
  // Ignore nonsense from the caller: a negative or non-finite frame time would
  // otherwise poison the accumulator.
  if (!(delta_ms > 0.0)) {
    return 0;
  }

  // Cap the frame so returning to a backgrounded tab does not replay the whole
  // stall in one go.
  accumulator_ms_ += delta_ms < kMaxFrameMs ? delta_ms : kMaxFrameMs;

  std::int32_t steps = 0;
  while (accumulator_ms_ >= step_ms_) {
    accumulator_ms_ -= step_ms_;
    step_once();
    ++steps;
  }

  // One rebuild per frame rather than per step: the renderer only ever sees the
  // state the last step left behind, and each follower's pose before it.
  if (steps > 0) {
    followers_.refresh_instances();
    huts_.refresh_instances();
    trees_.refresh_instances();
  }

  return steps;
}

std::int32_t Simulation::run_steps(std::int32_t count) {
  std::int32_t steps = 0;
  for (; steps < count; ++steps) {
    step_once();
  }
  if (steps > 0) {
    followers_.refresh_instances();
    huts_.refresh_instances();
    trees_.refresh_instances();
  }
  return steps;
}

void Simulation::step_once() {
  const double dt_seconds = step_ms_ / 1000.0;
  ++step_count_;
  // Before anyone moves: the pose each follower is drawn from towards the one
  // this step leaves.
  followers_.mark_step();
  followers_.step(dt_seconds);
  // After the followers have moved, so someone who reached a door this step
  // goes in on it.
  huts_.step(dt_seconds);
  // After huts, so a tree a hut has just been raised over is cleared before
  // anyone chops at it.
  trees_.step(dt_seconds);
  // Last, so mana counts the tribe as this step left it: births and all.
  shamans_.step(dt_seconds);
  // After everything, so a tribe's AI decides on the world this step left:
  // a hut that has just gone up, a cast that has just landed.
  ai_.step(dt_seconds);

  if (step_count_ % kCheckpointEverySteps == 0 &&
      checkpoints_.size() < static_cast<std::size_t>(kMaxCheckpoints)) {
    checkpoints_.push_back({step_count_, state_hash()});
  }
}

void Simulation::clear_world() {
  // Huts first: they give their footprints back to the grid.
  huts_.clear();
  trees_.clear();
  followers_.clear();
  shamans_.clear();
  stores_.clear();
  ai_.clear();
}

void Simulation::reset() {
  accumulator_ms_ = 0.0;
  step_count_ = 0;
  checkpoints_.clear();
}

}  // namespace inkulous
