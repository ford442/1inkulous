#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "1inkulous/followers.hpp"
#include "1inkulous/huts.hpp"
#include "1inkulous/nav.hpp"

// Shamans: one special follower per tribe, the mana her people pray up, and
// the one spell she knows so far — Land Bridge.
//
// The shaman herself is an ordinary follower with kFlagShaman set, so she
// walks, paths and is selected through FollowerSet like everyone else. What
// lives here is what only she has: her tribe's mana, and the check behind a
// cast.
//
// Land Bridge raises a strip of land along the great circle between two
// points. The terrain is TypeScript's — the planet mesh owns the heights — so
// the core does not deform anything itself. It decides whether the cast may
// go ahead, charges for it, and hands back a plan: a row of stamp centres, the
// crest height and the stamp radius. TypeScript lays the stamps with the same
// sculpt primitive the brush uses and writes the new heights into the nav
// buffer, so the very next order walks over the new land with no graph
// rebuild. A refused cast hands back no plan, so nothing moves.

namespace inkulous {

// Tribes the core keeps mana for: the four placeholder colours.
constexpr std::int32_t kMaxTribes = 4;

// Mana each living member of a tribe — out walking or inside a hut — adds per
// second. A village of a dozen pays for a bridge in a quarter of a minute.
constexpr double kManaPerPersonSecond = 1.0;
// Mana stops piling up here.
constexpr double kMaxMana = 1000.0;

constexpr double kLandBridgeCost = 200.0;
// Both ends of a bridge must lie within this of the shaman, in world units
// along the surface. On the unit planet that is a few grid cells: a strait,
// not an ocean.
constexpr double kLandBridgeRange = 0.3;
// An end counts as ashore when walkable land is within this of it, so a click
// in the shallows a cell off the beach still joins the beach.
constexpr double kLandBridgeShoreReach = 0.1;
// Radius of each stamp, in world units. The strip comes out about three grid
// cells wide — room for followers to pass two abreast.
constexpr double kLandBridgeHalfWidth = 0.09;
// Height the stamps raise the centre line to, above sea level.
constexpr double kLandBridgeHeight = 0.01;
// Most stamps a plan holds. A bridge at full range needs about fifteen.
constexpr std::int32_t kMaxLandBridgeStamps = 64;

// Why a Land Bridge will or will not go ahead. Values cross the ABI as ints.
enum class LandBridge : std::int32_t {
  kOk = 0,
  kNoGrid = 1,
  // The tribe has no shaman to cast it.
  kNoShaman = 2,
  // An end is further from the shaman than kLandBridgeRange.
  kOutOfRange = 3,
  // Neither end is near land: a bridge from nowhere to nowhere.
  kNoShore = 4,
  // The line is dry already; there is nothing to raise.
  kDry = 5,
  // Not enough mana.
  kNoMana = 6,
};

class Shamans {
 public:
  // None is owned; all must outlive the set.
  void attach(NavGrid* grid, FollowerSet* followers, HutSet* huts) {
    grid_ = grid;
    followers_ = followers;
    huts_ = huts;
  }

  // Spawns `tribe`'s shaman on the walkable node nearest the direction.
  // Returns her follower id, or -1 if the tribe already has one, the tribe is
  // out of range, or the follower set refuses the spawn.
  std::int32_t spawn(double x, double y, double z, std::int32_t tribe);

  // 0 for a tribe out of range.
  double mana(std::int32_t tribe) const;
  // Clamped to [0, kMaxMana]. For tests and scenario setup.
  void set_mana(std::int32_t tribe, double mana);
  // Mana per second the tribe is gaining right now.
  double income(std::int32_t tribe) const;
  // Everyone of the tribe, walking or housed, as of the last step.
  std::int32_t population(std::int32_t tribe) const;

  // Whether `tribe`'s shaman could raise a bridge from `a` to `b`, and if not,
  // why. Charges nothing and leaves the plan alone.
  LandBridge check_land_bridge(std::int32_t tribe, const double a[3], const double b[3]);
  // The same check; on kOk the mana is spent and the plan is written. On any
  // refusal the plan is emptied and no mana moves.
  LandBridge cast_land_bridge(std::int32_t tribe, const double a[3], const double b[3]);

  // The last successful cast's stamps: 3 floats (a unit direction) each.
  const float* stamps() const { return stamps_.data(); }
  std::int32_t stamp_count() const { return static_cast<std::int32_t>(stamps_.size() / 3); }
  // Angular radius of every stamp, in radians.
  double stamp_angle() const;

  // One fixed step: counts each tribe and adds its mana.
  void step(double dt_seconds);

  void clear();

 private:
  LandBridge plan(std::int32_t tribe, const double a[3], const double b[3], bool commit);
  // True when some point of the ground under `dir` that carries real weight
  // is water — the line needs raising there.
  bool wet(const double dir[3]) const;
  // Direction of the walkable node nearest `dir` when it lies within
  // kLandBridgeShoreReach; false otherwise.
  bool shore_near(const double dir[3], double out[3]) const;
  void count_population();

  NavGrid* grid_ = nullptr;
  FollowerSet* followers_ = nullptr;
  HutSet* huts_ = nullptr;
  std::array<double, kMaxTribes> mana_{};
  std::array<std::int32_t, kMaxTribes> population_{};
  std::vector<float> stamps_;
};

}  // namespace inkulous
