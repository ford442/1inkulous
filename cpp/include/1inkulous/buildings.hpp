#pragma once

#include <cstdint>
#include <vector>

#include "1inkulous/nav.hpp"

// Buildings: the first thing that claims a patch of land.
//
// A site is one walkable nav node. Its neighbourhood — that node and every
// node linked to it — has to be land, and every link inside that patch has to
// sit under a slope cap stricter than the walk limit, flat enough to read as
// a pad. The player makes one by sculpting; placing a building does not move
// the ground.
//
// The whole neighbourhood is the footprint. Those nodes are taken, so a second
// hut cannot stand on them. Paths will refuse the footprint later; they do
// not yet.
//
// Buildings are owned here the same way followers are: dense ids, one packed
// instance buffer, nothing copied across the WASM boundary per frame.

namespace inkulous {

// Floats per building in the render instance buffer:
//   0..2  world position of the anchor node, on the ground
//   3     tribe index, as a float
//   4     kind, as a float — see kBuildingKindHut
//   5     occupant count, as a float
//   6     flags bitfield, as a float
//   7     reserved, zero
constexpr std::int32_t kBuildingInstanceFloats = 8;

// Hard ceiling, for the same reason as kMaxFollowers: the renderer sizes its
// buffer once.
constexpr std::int32_t kMaxBuildings = 256;

// Placeholder hut radius in world units. The site test is the nav
// neighbourhood, not this disc; the mesh and the build cursor use it.
constexpr double kBuildingRadius = 0.05;

// Steepest pad, as height change over arc length — the same measure as
// kDefaultMaxSlope (0.55, a shade under 30 degrees). 0.15 is about 8.5
// degrees: still a slope, but flat enough to read as a floor.
constexpr double kBuildingMaxSlope = 0.15;

// The first kind. Later kinds (stores, towers) share this set.
constexpr std::int32_t kBuildingKindHut = 0;

// Why a site will or will not take a building. Values cross the ABI as ints.
enum class BuildingSite : std::int32_t {
  kOk = 0,
  kNoGrid = 1,
  // The anchor, or some node of its neighbourhood, is water.
  kWater = 2,
  // A link inside the neighbourhood is steeper than kBuildingMaxSlope.
  kSteep = 3,
  // The footprint overlaps a building already standing.
  kOccupied = 4,
  // kMaxBuildings already stand.
  kFull = 5,
};

class BuildingSet {
 public:
  // The grid is not owned; it must outlive the set.
  void set_grid(NavGrid* grid) { grid_ = grid; }

  // Whether a building could stand on the nav node nearest the direction.
  BuildingSite check_site(double x, double y, double z);

  // Claims that node for tribe `tribe` and kind `kind`. Returns its id, or -1
  // if check_site refuses the spot or `kind` is nonsense. Does not sculpt.
  std::int32_t place(double x, double y, double z, std::int32_t tribe, std::int32_t kind);

  void clear();

  std::int32_t count() const { return static_cast<std::int32_t>(buildings_.size()); }

  // True when `node` lies in some building's footprint. Pathfinding will use
  // this to refuse the pad; placement already does.
  bool blocked(std::int32_t node) const;

  const float* instances() const { return instances_.data(); }
  void refresh_instances();

 private:
  struct Building {
    // Nav node the hut is anchored to. Height is read from it live, so a
    // sculpt stroke under the hut lifts the hut with the ground.
    std::int32_t node = -1;
    std::int32_t tribe = 0;
    std::int32_t kind = kBuildingKindHut;
    std::int32_t occupants = 0;
    std::int32_t flags = 0;
    // Anchor first, then its neighbours. Taken for as long as the building
    // stands.
    std::vector<std::int32_t> footprint;
  };

  // Fills `footprint` with `node` and its neighbours. False if `node` is not
  // a node.
  bool collect_footprint(std::int32_t node, std::vector<std::int32_t>& footprint) const;
  // Water, then steep, then occupied. `kOk` when the patch can take a hut,
  // apart from the population cap.
  BuildingSite judge(const std::vector<std::int32_t>& footprint) const;
  bool linked_in_patch(std::int32_t from, std::int32_t to, const std::vector<std::int32_t>& footprint) const;
  void rebuild_owners();

  NavGrid* grid_ = nullptr;
  std::vector<Building> buildings_;
  // Building id standing on each node, or -1. Sized to the grid.
  std::vector<std::int32_t> node_owner_;
  std::vector<float> instances_;
  // Scratch for check_site / place, so a click does not allocate.
  std::vector<std::int32_t> footprint_scratch_;
};

}  // namespace inkulous
