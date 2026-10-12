#pragma once

#include <cstdint>
#include <vector>

#include "1inkulous/followers.hpp"
#include "1inkulous/nav.hpp"

// Huts: the first buildings, and the first game loop.
//
// The player flattens a pad, drops a hut on it, and sends followers in. A
// follower that reaches the doorstep goes inside — it leaves the follower set
// and becomes one of the hut's occupants — and a hut with people in it breeds:
// every so often a new follower of the hut's tribe steps out of the door. More
// occupants, quicker births, up to the hut's capacity.
//
// This milestone's huts are free and all alike. They do not block walking,
// and sculpting under one leaves it standing at whatever height the ground
// has; both come with real buildings later.

namespace inkulous {

// Floats per hut in the render instance buffer:
//   0..2  world position of the hut's centre, on the ground
//   3..5  unit heading, tangent to the surface — the way the door faces
//   6     tribe index, as a float; -1 while nobody has claimed it
//   7     occupants, as a float
constexpr std::int32_t kHutInstanceFloats = 8;

// Hard ceiling on huts, for the same reason as kMaxFollowers: the renderer
// sizes its buffer once.
constexpr std::int32_t kMaxHuts = 256;

// Footprint radius, in world units on the unit planet. A hut is about two
// grid cells across — the scale of a small hut against a brave in the
// original — and three times a follower's height.
constexpr double kHutRadius = 0.05;

// How far round the centre the ground must be flat, and how flat: the spread
// of heights over every node and footprint sample in reach. Rolling country
// mostly fails this, so a site is something the player makes with the
// flatten brush; the odd naturally level spot passes.
constexpr double kHutSiteRadius = 0.07;
constexpr double kHutMaxUnevenness = 0.0025;

// Closest two huts may stand, centre to centre: two footprints and a gap a
// follower can walk through.
constexpr double kHutMinSeparation = kHutRadius * 2.0 + kFollowerSpacing;

// People a hut holds.
constexpr std::int32_t kHutCapacity = 3;

// Occupant-seconds per birth. One occupant breeds once in this long; a full
// hut three times as often.
constexpr double kHutBreedSeconds = 30.0;

// A follower ordered in goes inside once it is this close to the centre:
// at the wall, give or take a body. Wide enough that a group sent in reaches
// it from the spots the formation hands out round the hut.
constexpr double kHutEntryReach = kHutRadius + kFollowerSpacing * 1.5;

// Newborns appear this far out of the door, clear of the wall.
constexpr double kHutDoorDistance = kHutRadius + kFollowerSpacing;

// Why a site will or will not take a hut. Values cross the ABI as ints.
enum class HutSite : std::int32_t {
  kOk = 0,
  kNoGrid = 1,
  // Some of the footprint is water, or off the edge of the map.
  kWater = 2,
  // Not flat enough: flatten it first.
  kUneven = 3,
  // Too close to another hut.
  kCrowded = 4,
  // kMaxHuts already stand.
  kFull = 5,
};

class HutSet {
 public:
  // Neither is owned; both must outlive the set.
  void attach(NavGrid* grid, FollowerSet* followers) {
    grid_ = grid;
    followers_ = followers;
  }

  // Whether a hut could stand centred on the direction, and if not, why.
  HutSite check_site(double x, double y, double z) const;

  // Builds a hut centred on the direction, its door facing along `heading`
  // (projected onto the surface; any tangent if it is degenerate). Returns its
  // id, or -1 if check_site refuses the spot.
  std::int32_t place(double x, double y, double z, double hx, double hy, double hz);

  void clear();

  std::int32_t count() const { return static_cast<std::int32_t>(huts_.size()); }
  // -1 for a bad id.
  std::int32_t occupants(std::int32_t id) const;
  std::int32_t tribe(std::int32_t id) const;
  // Everyone inside every hut.
  std::int32_t housed() const;

  // Sends selected followers into hut `id`: as many as it has room for once
  // those already on their way are counted, nearest first, and only of the
  // hut's tribe. An unclaimed hut takes the tribe of the nearest selected
  // follower. Returns how many were sent.
  std::int32_t order_enter_selected(std::int32_t id);

  // One fixed step: lets in whoever has reached the hut they were sent to,
  // drops orders that can no longer arrive, and breeds.
  void step(double dt_seconds);

  const float* instances() const { return instances_.data(); }
  void refresh_instances();

 private:
  struct Hut {
    double dir[3] = {0.0, 1.0, 0.0};
    double heading[3] = {1.0, 0.0, 0.0};
    std::int32_t tribe = -1;
    std::int32_t occupants = 0;
    // Towards the next birth, in births: one is due at 1.
    double breeding = 0.0;
    // Node nearest the centre, kept as a hint for reading the ground.
    std::int32_t node = -1;
  };

  // Followers already sent into hut `id` and not yet arrived.
  std::int32_t incoming(std::int32_t id) const;
  void admit_arrivals();
  void breed(double dt_seconds);

  NavGrid* grid_ = nullptr;
  FollowerSet* followers_ = nullptr;
  std::vector<Hut> huts_;
  std::vector<float> instances_;
};

}  // namespace inkulous
