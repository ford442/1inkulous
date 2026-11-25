#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "1inkulous/followers.hpp"
#include "1inkulous/nav.hpp"
#include "1inkulous/tribes.hpp"

// Huts: the buildings, and the first game loop.
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
// There are two kinds on the same footprint rules. A dwelling is the hut
// above. A training hut takes one brave at a time and, for some wood and a
// few seconds, lets a warrior out of the door instead. Building costs wood
// from the tribe's stockpile; a tribe's first dwelling is free, so a match
// can start before anyone has felled a tree. Either kind can be emptied:
// eject sends everyone inside back out of the door as braves.
//
// Owned here the same way followers are: dense ids, one packed instance
// buffer, nothing copied across the WASM boundary per frame.

namespace inkulous {

// Floats per hut in the render instance buffer:
//   0..2  world position of the hut's centre, on the ground
//   3..5  unit heading, tangent to the surface — the way the door faces
//   6     tribe index, as a float; -1 while nobody has claimed it
//   7     occupants, as a float
//   8     kind, as a float — see HutKind
constexpr std::int32_t kHutInstanceFloats = 9;

// What a building is for. Values cross the ABI as ints.
enum class HutKind : std::int32_t {
  // Houses up to kHutCapacity and breeds.
  kDwelling = 0,
  // Turns one brave and kWarriorWoodCost wood into a warrior.
  kTraining = 1,
};
constexpr std::int32_t kHutKindCount = 2;

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

// People a dwelling holds, and a training hut.
constexpr std::int32_t kHutCapacity = 3;
constexpr std::int32_t kTrainingCapacity = 1;

// Wood a dwelling costs, after the tribe's first, which is free; and a
// training hut, which never is. A tree gives kWoodPerTree (trees.hpp).
constexpr std::int32_t kHutWoodCost = 10;
constexpr std::int32_t kTrainingHutWoodCost = 15;
// Wood a warrior's training costs, paid as the brave goes in, and the
// seconds it takes before the warrior steps out.
constexpr std::int32_t kWarriorWoodCost = 5;
constexpr double kTrainSeconds = 8.0;

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
  // The tribe building it cannot pay the wood.
  kNoWood = 6,
};

class HutSet {
 public:
  // None is owned; all must outlive the set. Without stores, building is
  // free and training costs nothing.
  void attach(NavGrid* grid, FollowerSet* followers, Stockpile* stores) {
    grid_ = grid;
    followers_ = followers;
    stores_ = stores;
  }

  // Whether `tribe` could build a hut of `kind` on the nav node nearest the
  // direction, and if not, why: the ground first, then the wood. A negative
  // tribe asks about the ground alone. Also records that node's direction
  // and footprint radius; see site_point(). An unknown kind is kNoGrid.
  HutSite check_site(double x, double y, double z, HutKind kind, std::int32_t tribe);

  // Wood `tribe`'s next hut of `kind` would cost: 0 for its first dwelling,
  // and for an unclaimed hut (a negative tribe).
  std::int32_t cost(HutKind kind, std::int32_t tribe) const;
  static std::int32_t capacity(HutKind kind) {
    return kind == HutKind::kTraining ? kTrainingCapacity : kHutCapacity;
  }

  // The last check_site's footprint: the anchor's unit direction, which is
  // where the hut would be centred, and the angle from it to the furthest
  // footprint node. Zeros if that check found no node.
  const float* site_point() const { return site_point_; }

  // Builds a hut of `kind` on the node nearest the direction, its door
  // facing along `heading` (projected onto the surface; any tangent if it is
  // degenerate), owned by `tribe` — or by nobody, claimed by the first tribe
  // sent in, if it is negative. Charges the tribe its cost, blocks the
  // footprint and moves anyone standing on it to free ground. Returns its id,
  // or -1 if check_site refuses the spot or the wood.
  std::int32_t place(double x,
                     double y,
                     double z,
                     double hx,
                     double hy,
                     double hz,
                     std::int32_t tribe,
                     HutKind kind);

  // Removes every hut and frees their footprints.
  void clear();

  std::int32_t count() const { return static_cast<std::int32_t>(huts_.size()); }
  // -1 for a bad id.
  std::int32_t occupants(std::int32_t id) const;
  std::int32_t tribe(std::int32_t id) const;
  // -1 for a bad id.
  std::int32_t kind(std::int32_t id) const;
  // Everyone inside every hut.
  std::int32_t housed() const;
  // Unit direction of hut `id`'s centre; `id` must be in range.
  const double* direction(std::int32_t id) const { return huts_[static_cast<std::size_t>(id)].dir; }

  // Sends selected braves into hut `id`: as many as it has room for once
  // those already on their way are counted, nearest first, and only of the
  // hut's tribe. An unclaimed hut takes the tribe of the nearest selected
  // brave. The shaman and warriors never go in. A training hut takes
  // nobody while its tribe is short of a warrior's wood. Returns how many
  // were sent.
  std::int32_t order_enter_selected(std::int32_t id);
  // The same order for an explicit list of ids, which is what a tribe's AI
  // gives. Ids that are not braves of a tribe still taking orders are passed
  // over.
  std::int32_t order_enter(const std::vector<std::int32_t>& ids, std::int32_t id);
  // Followers already sent into hut `id` and not yet arrived; 0 for a bad id.
  std::int32_t incoming(std::int32_t id) const;

  // Sends everyone inside hut `id` back out of the door as braves, the
  // reverse of going in. They rejoin the follower set, so they stop when it
  // is full; whoever does not fit stays inside. A brave let out of training
  // gets its tribe's wood back. Returns how many came out.
  std::int32_t eject(std::int32_t id);

  // One fixed step: lets in whoever has reached the hut they were sent to,
  // drops orders that can no longer arrive, breeds, and trains.
  void step(double dt_seconds);

  const float* instances() const { return instances_.data(); }
  void refresh_instances();

 private:
  struct Hut {
    double dir[3] = {0.0, 1.0, 0.0};
    double heading[3] = {1.0, 0.0, 0.0};
    std::int32_t tribe = -1;
    HutKind kind = HutKind::kDwelling;
    std::int32_t occupants = 0;
    // Towards the next birth, in births: one is due at 1.
    double breeding = 0.0;
    // Towards the warrior a training hut is making: out at 1.
    double training = 0.0;
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
  void door_point(const Hut& hut, double out[3]) const;
  void admit_arrivals();
  void breed(double dt_seconds);
  void train(double dt_seconds);

  NavGrid* grid_ = nullptr;
  FollowerSet* followers_ = nullptr;
  Stockpile* stores_ = nullptr;
  // Whether each tribe has had its free dwelling.
  std::array<bool, kMaxTribes> free_dwelling_used_{};
  std::vector<Hut> huts_;
  std::vector<float> instances_;
  // The grid generation the footprints were last marked on.
  std::uint32_t marked_generation_ = 0;
  // Scratch for check_site / place, so a frame's ghost does not allocate.
  std::vector<std::int32_t> footprint_scratch_;
  float site_point_[4] = {0.0f, 0.0f, 0.0f, 0.0f};
};

}  // namespace inkulous
