#pragma once

#include <cstdint>
#include <vector>

#include "1inkulous/followers.hpp"
#include "1inkulous/nav.hpp"
#include "1inkulous/tribes.hpp"

// Trees: where wood comes from.
//
// A tree stands on a nav node of dry land above the shore — one whose
// neighbours are all dry too, so never on a beach. They are scattered once at
// match start from the height field the core already owns, and never grow
// back. A tree does not block walking: it is a point a brave walks up to.
//
// A brave sent to a tree walks there like any other order, with the tree
// remembered on it. Within reach it chops: each chopper adds its share of a
// fixed step to the tree's progress, and when that reaches a whole tree's
// worth the tree leaves the set and its wood goes to the chopper's tribe.
//
// Trees go without wood, too: ground sculpted under the sea drowns the tree on
// it, and a hut raised over one clears it from the footprint.
//
// Owned like followers and huts: dense ids, one packed instance buffer, read
// straight out of linear memory to draw.

namespace inkulous {

// Floats per tree in the render instance buffer:
//   0..2  world position of the foot of the trunk, on the ground
//   3..5  unit heading, tangent to the surface: the way it leans as it falls
//   6     size, as a multiple of the placeholder mesh
//   7     how far through chopping it is, 0..1
constexpr std::int32_t kTreeInstanceFloats = 8;

// Ceiling on trees, for the renderer to size its buffer once.
constexpr std::int32_t kMaxTrees = 512;

// Wood a felled tree gives its tribe.
constexpr std::int32_t kWoodPerTree = 5;
// Brave-seconds to fell one: alone, four seconds; three together, under two.
constexpr double kChopSeconds = 4.0;
// Most braves one chop order sends to a tree.
constexpr std::int32_t kChoppersPerTree = 3;
// Within this of a tree, centre to centre in world units, a brave sent to it
// is chopping. Room for a small group packed round the trunk.
constexpr double kChopReach = 0.05;

class TreeSet {
 public:
  // None is owned; all must outlive the set.
  void attach(NavGrid* grid, FollowerSet* followers, Stockpile* stores) {
    grid_ = grid;
    followers_ = followers;
    stores_ = stores;
  }

  // Scatters up to `how_many` trees over dry land above the shore, chosen by a
  // generator seeded with `seed` so a match starts the same way twice. No
  // two stand on neighbouring nodes, none under a hut. Replaces any trees
  // already standing. Returns how many were planted.
  std::int32_t spawn(std::int32_t how_many, std::uint32_t seed);

  void clear();

  std::int32_t count() const { return static_cast<std::int32_t>(trees_.size()); }
  // Unit direction of tree `id`; `id` must be in range.
  const double* direction(std::int32_t id) const {
    return trees_[static_cast<std::size_t>(id)].dir;
  }
  // 0..1 through chopping, or -1 for a bad id.
  double progress(std::int32_t id) const;

  // Sends selected braves to chop tree `id`: the nearest, up to
  // kChoppersPerTree once those already on their way are counted. Warriors
  // and the shaman stay put. Returns how many were sent.
  std::int32_t order_chop_selected(std::int32_t id);
  // The same order for an explicit list of ids, which is what a tribe's AI
  // gives. Anyone not a brave of a tribe still taking orders is passed over.
  std::int32_t order_chop(const std::vector<std::int32_t>& ids, std::int32_t id);

  // Plants one tree on the walkable node nearest the direction, unless a
  // tree already stands on that node. For tests and scenario setup; a match
  // starts from spawn(). Returns its id, or -1.
  std::int32_t plant(double x, double y, double z);

  // One fixed step: drops trees the ground has drowned or a hut has covered,
  // lets everyone in reach of the tree they were sent to chop at it, fells
  // whatever is done, and drops orders that can no longer arrive.
  void step(double dt_seconds);

  const float* instances() const { return instances_.data(); }
  void refresh_instances();

 private:
  struct Tree {
    double dir[3] = {0.0, 1.0, 0.0};
    double heading[3] = {1.0, 0.0, 0.0};
    double size = 1.0;
    std::int32_t node = -1;
    // Chopped so far, in trees: felled at 1.
    double progress = 0.0;
  };

  // Takes tree `id` out and tells the followers, whose tree ids shift.
  void remove(std::int32_t id);
  // Drowned or built over.
  bool lost(const Tree& tree) const;
  std::int32_t incoming(std::int32_t id) const;

  NavGrid* grid_ = nullptr;
  FollowerSet* followers_ = nullptr;
  Stockpile* stores_ = nullptr;
  std::vector<Tree> trees_;
  std::vector<float> instances_;
};

}  // namespace inkulous
