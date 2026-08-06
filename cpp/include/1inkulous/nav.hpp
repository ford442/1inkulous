#pragma once

#include <cstdint>
#include <vector>

// Navigation graph on the planet surface.
//
// The graph is the planet mesh's *welded* vertex grid: one node per distinct
// surface position, so the six cube faces stitch together without any
// face-adjacency bookkeeping in here. TypeScript owns the mesh, builds the node
// directions and the adjacency once, and writes them straight into the buffers
// this class hands out — nothing is marshalled through call arguments.
//
// Heights are the one part that keeps changing: terrain deformation rewrites
// them, and the same buffer is simply overwritten in place, so a raised
// mountain blocks a path on the very next search.

namespace inkulous {

// Land is anything above sea level. Sculpting snaps flooded vertices to exactly
// zero, so a plain "greater than nothing" test is the water line; the epsilon is
// only there to absorb float32 rounding.
constexpr float kWaterHeight = 1e-6f;

// Steepest ground a follower will cross, as height change over arc length —
// i.e. the tangent of the slope angle. 0.55 is a shade under 30 degrees, which
// leaves gentle hills walkable and turns sculpted cliffs into real barriers.
constexpr double kDefaultMaxSlope = 0.55;

class NavGrid {
 public:
  // Sizes the graph. `link_count` is the total length of the neighbour list —
  // the sum of every node's degree. Returns false on nonsense sizes.
  bool allocate(std::int32_t node_count, std::int32_t link_count);

  // Called once the buffers are filled. `max_slope` <= 0 uses the default.
  // The grid only reports `ready` if the CSR topology checks out.
  void commit(double planet_radius, double max_slope);

  std::int32_t node_count() const { return node_count_; }
  std::int32_t link_count() const { return link_count_; }
  bool ready() const { return committed_; }
  double planet_radius() const { return planet_radius_; }
  double max_slope() const { return max_slope_; }

  // Buffers handed to TypeScript to fill. Sizes: directions 3*N (unit vectors),
  // heights N, neighbour_offsets N+1 (CSR), neighbours link_count.
  float* directions() { return directions_.data(); }
  float* heights() { return heights_.data(); }
  std::int32_t* neighbor_offsets() { return neighbor_offsets_.data(); }
  std::int32_t* neighbors() { return neighbors_.data(); }

  const float* direction(std::int32_t node) const { return &directions_[node * 3]; }
  float height(std::int32_t node) const { return heights_[node]; }

  bool walkable(std::int32_t node) const { return heights_[node] > kWaterHeight; }

  // Whether a follower can step between two adjacent nodes: both on land, and
  // the ground between them no steeper than `max_slope`.
  bool passable(std::int32_t from, std::int32_t to) const;

  // Arc length along the surface between two nodes, in world units.
  double arc_length(std::int32_t from, std::int32_t to) const;

  // Closest node to a direction, which need not be normalised. -1 if empty.
  std::int32_t nearest_node(double x, double y, double z) const;
  // As above, but skips water and anywhere a follower could not stand.
  std::int32_t nearest_walkable_node(double x, double y, double z) const;

  // A* from `from` to `to`. On success `out` holds the node sequence to walk,
  // starting at the first node *after* `from` and ending at `to`.
  bool find_path(std::int32_t from, std::int32_t to, std::vector<std::int32_t>& out);

 private:
  // Whether the offsets TypeScript wrote describe a well-formed CSR. The
  // neighbour loop in find_path trusts them to index inside `neighbors_`, and
  // that buffer arrives across the WASM boundary as raw memory.
  bool offsets_valid() const;

  std::int32_t node_count_ = 0;
  std::int32_t link_count_ = 0;
  bool committed_ = false;
  double planet_radius_ = 1.0;
  double max_slope_ = kDefaultMaxSlope;

  std::vector<float> directions_;
  std::vector<float> heights_;
  std::vector<std::int32_t> neighbor_offsets_;
  std::vector<std::int32_t> neighbors_;

  // Search scratch, kept allocated between calls. `visit_stamp_` records which
  // search last touched a node, so a new search costs no clearing pass.
  std::vector<double> g_score_;
  std::vector<std::int32_t> came_from_;
  std::vector<std::uint32_t> visit_stamp_;
  std::vector<std::uint8_t> closed_;
  std::uint32_t stamp_ = 0;
};

}  // namespace inkulous
