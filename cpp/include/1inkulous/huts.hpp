#pragma once

#include <cstdint>
#include <vector>

#include "1inkulous/followers.hpp"
#include "1inkulous/nav.hpp"

// Huts: the one kind of building, and the first game loop.
//
// The player flattens a pad, drops a hut on it, and sends followers in. A
// follower that reaches the door goes inside — it leaves the follower set and
// becomes one of the hut's occupants — and a hut with people in it breeds:
// every so often a new follower of the hut's tribe steps out of the door. More
// occupants, quicker births, up to the hut's capacity.
//
// A hut stands on a nav node. That node and every node linked to it are its
// footprint: they have to be dry and level before it goes up, and once it
// stands they are blocked in the NavGrid, so routes, line tests and every
// step a follower takes go round the pad the way they go round water.
// Placing does not sculpt; sculpting under a standing hut carries it with
// the ground, and the footprint stays blocked whatever the heights do.
//
// Owned here the same way followers are: dense ids, one packed instance
// buffer, nothing copied across the WASM boundary per frame.

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

// Radius of the placeholder mesh, in world units on the unit planet. The
// footprint is the nav neighbourhood, which is always at least this wide on
// the planet grid; the ring under the walls is sampled too, so the mesh never
// overhangs water or the edge of an open patch.
constexpr double kHutRadius = 0.05;

// Spread of heights allowed over the footprint nodes and the ground under the
// walls. Rolling country mostly fails this, and so does a slope gentle
// enough to walk: a site is something the player makes with the flatten
// brush, with the odd naturally level spot.
constexpr double kHutMaxUnevenness = 0.0025;

// People a hut holds.
constexpr std::int32_t kHutCapacity = 3;

// Occupant-seconds per birth. One occupant breeds once in this long; a full
// hut three times as often.
constexpr double kHutBreedSeconds = 30.0;

// Why a site will or will not take a hut. Values cross the ABI as ints.
enum class HutSite : std::int32_t {
  kOk = 0,
  kNoGrid = 1,
  // Some of the footprint is water, or off the edge of the map.
  kWater = 2,
  // Not level enough: flatten it first.
  kUneven = 3,
  // The footprint overlaps or touches another hut's: two huts keep at least
  // one free node between them, a lane a follower can walk.
  kOccupied = 4,
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

  // Whether a hut could stand on the nav node nearest the direction, and if
  // not, why. Also records that node's direction and footprint radius; see
  // site_point().
  HutSite check_site(double x, double y, double z);

  // The last check_site's footprint: the anchor's unit direction, which is
  // where the hut would be centred, and the angle from it to the furthest
  // footprint node. Zeros if that check found no node.
  const float* site_point() const { return site_point_; }

  // Builds a hut on the node nearest the direction, its door facing along
  // `heading` (projected onto the surface; any tangent if it is degenerate),
  // owned by `tribe` — or by nobody, claimed by the first tribe sent in, if
  // it is negative. Blocks the footprint and moves anyone standing on it to
  // free ground. Returns its id, or -1 if check_site refuses the spot.
  std::int32_t place(double x, double y, double z, double hx, double hy, double hz,
                     std::int32_t tribe);

  // Removes every hut and frees their footprints.
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
  // follower. The shaman never goes in. Returns how many were sent.
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
    // The anchor node: `dir` is its direction, and the hut stands at its
    // height, read live so a sculpt stroke carries the hut with it.
    std::int32_t node = -1;
    // Anchor first, then its neighbours. Blocked for as long as it stands.
    std::vector<std::int32_t> footprint;
    // Angle from the centre to the door point, just clear of the footprint,
    // and the angle within which someone sent in counts as at the door: the
    // first free nodes round the pad, and a body's room past them.
    double door = 0.0;
    double reach = 0.0;
  };

  // Fills `footprint_scratch_` with `node` and its neighbours.
  void collect_footprint(std::int32_t node);
  // Water, then uneven, then occupied, for the footprint in scratch.
  HutSite judge(const double centre[3], std::int32_t node) const;
  // Re-marks every footprint after the grid has been reallocated.
  void sync_blocked();
  void mark(const Hut& hut, bool blocked);
  // Followers already sent into hut `id` and not yet arrived.
  std::int32_t incoming(std::int32_t id) const;
  void door_point(const Hut& hut, double out[3]) const;
  void admit_arrivals();
  void breed(double dt_seconds);

  NavGrid* grid_ = nullptr;
  FollowerSet* followers_ = nullptr;
  std::vector<Hut> huts_;
  std::vector<float> instances_;
  // The grid generation the footprints were last marked on.
  std::uint32_t marked_generation_ = 0;
  // Scratch for check_site / place, so a frame's ghost does not allocate.
  std::vector<std::int32_t> footprint_scratch_;
  float site_point_[4] = {0.0f, 0.0f, 0.0f, 0.0f};
};

}  // namespace inkulous
