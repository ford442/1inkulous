// Simulation core: the fixed-step clock everything else will hang off.
// Pathfinding, AI and sphere maths land here next.

#include "1inkulous/core.hpp"

namespace inkulous {
namespace {

// "0.2.0" — built by hand so the string is static storage with no allocation,
// which keeps core_version_text() safe to hand across the WASM boundary.
#define INKULOUS_STRINGIFY_(x) #x
#define INKULOUS_STRINGIFY(x) INKULOUS_STRINGIFY_(x)
constexpr const char* kVersionText = INKULOUS_STRINGIFY(0) "." INKULOUS_STRINGIFY(2) "." INKULOUS_STRINGIFY(0);

static_assert(kVersionMajor == 0 && kVersionMinor == 2 && kVersionPatch == 0,
              "kVersionText must be kept in step with the version constants");

}  // namespace

const char* core_version_string() { return kVersionText; }

int core_version() { return kVersion; }

Simulation::Simulation(double step_ms)
    : step_ms_(step_ms > 0.0 ? step_ms : kDefaultStepMs) {
  followers_.set_grid(&nav_);
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

  const double dt_seconds = step_ms_ / 1000.0;

  std::int32_t steps = 0;
  while (accumulator_ms_ >= step_ms_) {
    accumulator_ms_ -= step_ms_;
    ++step_count_;
    ++steps;
    followers_.step(dt_seconds);
  }

  // One rebuild per frame rather than per step: the renderer only ever sees the
  // state the last step left behind.
  if (steps > 0) {
    followers_.refresh_instances();
  }

  return steps;
}

void Simulation::reset() {
  accumulator_ms_ = 0.0;
  step_count_ = 0;
}

}  // namespace inkulous
