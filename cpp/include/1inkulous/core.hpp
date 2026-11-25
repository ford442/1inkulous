#pragma once

#include <cstdint>
#include <vector>

#include "1inkulous/followers.hpp"
#include "1inkulous/huts.hpp"
#include "1inkulous/nav.hpp"
#include "1inkulous/random.hpp"
#include "1inkulous/shaman.hpp"
#include "1inkulous/state_hash.hpp"
#include "1inkulous/terrain.hpp"
#include "1inkulous/trees.hpp"
#include "1inkulous/tribe_ai.hpp"
#include "1inkulous/tribes.hpp"

// Simulation core. Compiled to WebAssembly and driven from TypeScript through
// the flat C ABI in `core_abi.hpp` — pathfinding, AI and sphere maths will grow
// inside this namespace.
namespace inkulous {

// Semantic version of the core, so the loader can report what it got.
constexpr int kVersionMajor = 0;
constexpr int kVersionMinor = 11;
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

// Steps between state-hash checkpoints: five seconds at the default step.
// Often enough to say roughly when two runs parted, cheap enough to leave on.
constexpr std::int32_t kCheckpointEverySteps = 100;

// Checkpoints kept per match, allocated up front so a long match does not
// grow the heap: 4096 of them is over five hours at the default step. Past
// that the list stops; the hash itself is still there to ask for.
constexpr std::int32_t kMaxCheckpoints = 4096;

// The state hash as a step left it. See state_hash.hpp.
struct Checkpoint {
  std::int64_t step = 0;
  std::uint32_t hash = 0;
};

// Human-readable version, e.g. "0.1.0".
const char* core_version_string();

// Encoded version. Kept from the original placeholder.
int core_version();

// Fixed-step simulation clock and the world it drives. The renderer's frame
// time goes in and whole steps come out, so simulation behaviour does not
// depend on frame rate.
class Simulation {
 public:
  // `step_ms` is the fixed step length; anything <= 0 uses kDefaultStepMs.
  explicit Simulation(double step_ms = kDefaultStepMs);

  // The follower and hut sets hold pointers into this instance, so a Simulation
  // cannot be copied or moved out from under it. There is one world per module
  // anyway; re-timing goes through `set_step_ms`.
  Simulation(const Simulation&) = delete;
  Simulation& operator=(const Simulation&) = delete;

  // Advances by a frame's worth of time; returns how many fixed steps ran.
  std::int32_t advance(double delta_ms);

  // Runs exactly `count` fixed steps, whatever the accumulator holds, and
  // leaves the accumulator alone. What a replay and a lockstep peer drive the
  // core with: a step number, not a frame time. Returns how many ran.
  std::int32_t run_steps(std::int32_t count);

  // Changes the fixed step length and clears the clock. The world — navigation
  // graph and followers — is left alone.
  void set_step_ms(double step_ms);

  NavGrid& nav() { return nav_; }
  FollowerSet& followers() { return followers_; }
  HutSet& huts() { return huts_; }
  Shamans& shamans() { return shamans_; }
  Terrain& terrain() { return terrain_; }
  TreeSet& trees() { return trees_; }
  Stockpile& stores() { return stores_; }
  TribeAi& ai() { return ai_; }
  MatchRandom& random() { return random_; }

  // Seeds the match's generator. Call it once as the match starts, before
  // anything that draws from it (the forest).
  void seed_match(std::uint32_t seed) { random_.reseed(seed); }

  // FNV-1a of everything that decides the next step. Equal on two cores if and
  // only if (barring a collision) they will go on to do the same thing.
  std::uint32_t state_hash() const;

  // The hash every kCheckpointEverySteps steps since the clock was last
  // cleared, oldest first.
  const std::vector<Checkpoint>& checkpoints() const { return checkpoints_; }

  std::int64_t step_count() const { return step_count_; }
  // Simulated time in milliseconds, i.e. whole steps only.
  double elapsed_ms() const { return static_cast<double>(step_count_) * step_ms_; }
  double step_ms() const { return step_ms_; }
  // Time carried towards the next step, in milliseconds.
  double pending_ms() const { return accumulator_ms_; }
  // How far the clock is from the last step to the next, in [0, 1): what the
  // renderer draws each follower at, between its previous pose and this one.
  double step_alpha() const { return accumulator_ms_ / step_ms_; }

  // Clears the clock and the checkpoints taken against it.
  void reset();

 private:
  // One fixed step of every system, in order, then a checkpoint if one is due.
  void step_once();

  double step_ms_;
  double accumulator_ms_ = 0.0;
  std::int64_t step_count_ = 0;
  std::vector<Checkpoint> checkpoints_;
  MatchRandom random_;

  NavGrid nav_;
  Terrain terrain_;
  Stockpile stores_;
  FollowerSet followers_;
  TreeSet trees_;
  HutSet huts_;
  Shamans shamans_;
  TribeAi ai_;
};

}  // namespace inkulous
