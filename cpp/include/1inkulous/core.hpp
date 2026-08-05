#pragma once

#include <cstdint>

// Simulation core. Compiled to WebAssembly and driven from TypeScript through
// the flat C ABI in `core_abi.hpp` — pathfinding, AI and sphere maths will grow
// inside this namespace.
namespace inkulous {

// Semantic version of the core, so the loader can report what it got.
constexpr int kVersionMajor = 0;
constexpr int kVersionMinor = 1;
constexpr int kVersionPatch = 0;

// Encoded as MAJOR * 10000 + MINOR * 100 + PATCH: cheap to pass across the
// boundary and to compare.
constexpr int kVersion = kVersionMajor * 10000 + kVersionMinor * 100 + kVersionPatch;

// Default fixed step: 20 simulation ticks per second, roughly the cadence an RTS
// needs for unit decisions, and independent of render frame rate.
constexpr double kDefaultStepMs = 50.0;

// Guard against a stalled tab dumping minutes of accumulated time into one
// frame; anything beyond this is dropped rather than simulated in a burst.
constexpr double kMaxFrameMs = 250.0;

// Human-readable version, e.g. "0.1.0".
const char* core_version_string();

// Encoded version. Kept from the original placeholder.
int core_version();

// Fixed-step simulation clock. The renderer's frame time goes in and whole steps
// come out, so simulation behaviour does not depend on frame rate.
class Simulation {
 public:
  // `step_ms` is the fixed step length; anything <= 0 uses kDefaultStepMs.
  explicit Simulation(double step_ms = kDefaultStepMs);

  // Advances by a frame's worth of time; returns how many fixed steps ran.
  std::int32_t advance(double delta_ms);

  std::int64_t step_count() const { return step_count_; }
  // Simulated time in milliseconds, i.e. whole steps only.
  double elapsed_ms() const { return static_cast<double>(step_count_) * step_ms_; }
  double step_ms() const { return step_ms_; }
  // Time carried towards the next step, in milliseconds.
  double pending_ms() const { return accumulator_ms_; }

  void reset();

 private:
  double step_ms_;
  double accumulator_ms_ = 0.0;
  std::int64_t step_count_ = 0;
};

}  // namespace inkulous
