#pragma once

#include <cstddef>
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
// mountain blocks a path on the very next search. The nearest-node index is
// built from directions only, so those in-place height writes do not rebuild it.

namespace inkulous {

// Land is anything above sea level. Sculpting snaps flooded vertices to exactly
// zero, so a plain "greater than nothing" test is the water line; the epsilon is
// only there to absorb float32 rounding.
constexpr float kWaterHeight = 1e-6f;

// Steepest ground a follower will cross, as height change over arc length —
// i.e. the tangent of the slope angle. 0.55 is a shade under 30 degrees, which
// leaves gentle hills walkable and turns sculpted cliffs into real barriers.
constexpr double kDefaultMaxSlope = 0.55;

// A point on the surface between nodes. The ground there is the triangle of the
// nearest node's fan that holds the point, and the corners' weights are its
// barycentric coordinates — so height reads off the same piecewise-linear
// surface the planet mesh draws, near enough (the mesh splits some quads across
// the other diagonal).
struct SurfacePoint {
  // Nearest node first, then up to two fan neighbours. Unused corners are -1
  // with zero weight; a point on an edge has one neighbour, a point on a node
  // none.
  std::int32_t nodes[3] = {-1, -1, -1};
  double weights[3] = {0.0, 0.0, 0.0};
  // Link indices from nodes[0] to nodes[1] and to nodes[2], -1 where unused.
  std::int32_t links[2] = {-1, -1};
  double height = 0.0;
  // False when no triangle of the graph holds the point: off the edge of an
  // open patch. The closed planet has no such place.
  bool on_mesh = false;
};

// Share of a point's weight below which a corner does not count when deciding
// whether the point can be stood on. A point that close to an edge is on the
// edge — and float32 directions put points on the graph's own links a hair
// either side of it.
//
// Two levels. Routes, standing spots and the line tests behind them are held
// to the strict one; each step a follower takes is held to the loose one. The
// gap is what a route checked by sampling might have missed between samples,
// so a walker can always follow the leg it was given, and only a shove or a
// sculpt stroke ever puts it on ground as poor as the loose limit.
constexpr double kRouteSupport = 0.02;
constexpr double kStepSupport = 0.15;

// A place on a route: a direction (not necessarily a node's own) and the node
// nearest it.
struct NavPoint {
  double dir[3] = {0.0, 1.0, 0.0};
  std::int32_t node = -1;
};

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
  // The same for the step along link `link` out of `from`, whose length is
  // known in advance. Use it wherever the link index is to hand.
  bool passable_link(std::int32_t from, std::int32_t link) const;

  // Whether a route may take link `link` out of `from`: passable, and if it is
  // a diagonal, the quad it cuts across is good ground at every corner. That
  // is what keeps a node route standable all the way along — a diagonal past a
  // water corner would otherwise walk through that corner's cell.
  bool steppable(std::int32_t from, std::int32_t link) const;

  // Arc length along the surface between two nodes, in world units.
  double arc_length(std::int32_t from, std::int32_t to) const;

  // Closest node to a direction, which need not be normalised. Answered from a
  // grid hash of the directions built in commit(); a sample the hash cannot
  // prove falls back to a scan. -1 if the graph is empty or the direction is.
  std::int32_t nearest_node(double x, double y, double z) const;
  // As above, but skips water. Standing room is the height test; slope is
  // decided per step by passable(), not here.
  std::int32_t nearest_walkable_node(double x, double y, double z) const;

  // Nearest node to a direction, found by walking downhill on distance from
  // `hint` through the links. A follower moves a fraction of a cell per step, so
  // this is one or two neighbour scans where nearest_node would be a hash probe.
  // A bad hint, or one too far away, falls back to nearest_node.
  std::int32_t locate(const double dir[3], std::int32_t hint) const;

  // The ground under a direction. `node` must be the node nearest it.
  void sample(const double dir[3], std::int32_t node, SurfacePoint& out) const;

  // Whether a follower may stand there: on the mesh, and every corner that
  // carries more than `support` of the weight is land and within a step's
  // slope of the others. A point on an edge is held by that edge alone, so
  // walking the graph's own links never trips over a cliff beside them.
  bool standable(const SurfacePoint& point, double support) const;

  // Samples the ground under a direction and says whether it can be stood on
  // to `support`, reading the quad it falls in both ways it can be split. The
  // fan of `node` (the nearest) splits it along one diagonal, and right at the
  // middle the nearest corner — and so the split — flips; a point either split
  // calls good ground is good ground. `out` gets the reading that decided.
  bool footing(const double dir[3], std::int32_t node, double support, SurfacePoint& out) const;

  // Whether the great circle from `from` to `to` stays on standable ground all
  // the way, to kRouteSupport. `from_node` is the node nearest `from`; `from`
  // itself is not tested, so a follower that has been pushed onto bad ground
  // can still be routed off it.
  bool clear_line(const double from[3], std::int32_t from_node, const double to[3]) const;

  // A* from `from` to `to`. On success `out` holds the node sequence to walk,
  // starting at the first node *after* `from` and ending at `to`.
  bool find_path(std::int32_t from, std::int32_t to, std::vector<std::int32_t>& out);

  // One search serving a whole group bound for the same node. Settles nodes
  // outwards from `to` until every node in `starts` that can reach it has been
  // reached, which costs about one A* for the furthest walker instead of one
  // per walker. False if `to` is not a place to walk to.
  bool search_toward(std::int32_t to, const std::vector<std::int32_t>& starts);
  // The route from `from` to the last search_toward goal, in find_path's
  // format. Valid only until the next search of either kind; false if `from`
  // cannot get there or was not among the starts.
  bool path_toward(std::int32_t from, std::vector<std::int32_t>& out) const;
  // Length of that route along the ground, or infinity if there is none.
  double distance_toward(std::int32_t from) const;

  // String-pulls a node route into straight legs. `start` is where the walker
  // actually is, with the node its route sets off from; `nodes` is the route,
  // in find_path's format; `goal` is the exact point to finish on, which must
  // lie in the cell of the route's last node. `out` gets the waypoints after
  // `start`, ending at `goal`. Every leg is either one the route already
  // walked node to node or one clear_line has checked, so smoothing never
  // invents a step the search would refuse.
  void smooth_path(const NavPoint& start,
                   const std::vector<std::int32_t>& nodes,
                   const NavPoint& goal,
                   std::vector<NavPoint>& out);

  // Shortest and longest link on the graph, in radians. Set by commit().
  double min_link_angle() const { return min_link_angle_; }
  double max_link_angle() const { return max_link_angle_; }

 private:
  // Whether the offsets and neighbour ids TypeScript wrote describe a
  // well-formed CSR. Every walk over the graph trusts them to index inside
  // `neighbors_` and the per-node buffers, and they arrive across the WASM
  // boundary as raw memory.
  bool offsets_valid() const;
  // Precomputes what sampling and searching need from the fixed topology: a
  // tangent frame per node, each link in its node's frame, link lengths, and
  // each diagonal's other two corners.
  void prepare_geometry();
  bool passable_run(std::int32_t from, std::int32_t to, double run) const;
  // passable() between two nodes that are usually linked, using the link's
  // stored length when there is one.
  bool passable_near(std::int32_t from, std::int32_t to) const;
  // footing() for a point sample() has already read from its nearest node.
  bool footing_sampled(const double dir[3], double support, SurfacePoint& out) const;
  // Starts a new search generation over the stamped scratch.
  void next_stamp();

  void build_spatial_index();
  void clear_spatial_index();
  // `walkable_only` skips water. Both queries share the index.
  std::int32_t nearest_impl(double x, double y, double z, bool walkable_only) const;
  std::int32_t nearest_linear(double nx, double ny, double nz, bool walkable_only) const;
  // Slot whose key matches, or the empty slot where it would be inserted.
  std::size_t spatial_probe(std::uint32_t key) const;

  // One cell of the direction hash. `count == 0` is an empty probe slot;
  // occupied slots point at a run of node ids in `spatial_nodes_`.
  struct SpatialSlot {
    std::uint32_t key = 0;
    std::int32_t start = 0;
    std::int32_t count = 0;
  };

  std::int32_t node_count_ = 0;
  std::int32_t link_count_ = 0;
  bool committed_ = false;
  double planet_radius_ = 1.0;
  double max_slope_ = kDefaultMaxSlope;
  double min_link_angle_ = 0.0;
  double max_link_angle_ = 0.0;
  // Arc between samples on a clear_line walk: a fraction of the shortest link,
  // so no cell is stepped over.
  double line_step_ = 0.0;
  // Per node, two unit tangents (e1 then e2). Per link, the neighbour's
  // position in its node's tangent plane (u, v) and one over the length of
  // that, zero for a degenerate link.
  std::vector<float> node_frames_;
  std::vector<float> link_frames_;
  // Arc length of each link in world units.
  std::vector<double> link_lengths_;
  // For a diagonal link, the quad's other two corners (c, d), else -1; and
  // the runs a-c, c-b, a-d, d-b, c-d for checking the quad's slopes.
  std::vector<std::int32_t> link_corners_;
  std::vector<float> link_corner_runs_;

  std::vector<float> directions_;
  std::vector<float> heights_;
  std::vector<std::int32_t> neighbor_offsets_;
  std::vector<std::int32_t> neighbors_;

  // Direction hash. Invalidated by allocate(); rebuilt only when commit()
  // accepts the topology. Heights are not stored here.
  std::vector<SpatialSlot> spatial_slots_;
  std::vector<std::int32_t> spatial_nodes_;
  bool spatial_ready_ = false;

  // Search scratch, kept allocated between calls. `visit_stamp_` records which
  // search last touched a node, so a new search costs no clearing pass.
  std::vector<double> g_score_;
  std::vector<std::int32_t> came_from_;
  std::vector<std::uint32_t> visit_stamp_;
  std::vector<std::uint8_t> closed_;
  std::uint32_t stamp_ = 0;
  // search_toward's own state: which starts it is still waiting on, and which
  // goal and generation the scratch above currently describes.
  std::vector<std::uint32_t> want_stamp_;
  std::int32_t toward_ = -1;
  std::uint32_t toward_stamp_ = 0;

  // Candidate waypoints while smoothing, kept allocated between calls.
  std::vector<NavPoint> smooth_scratch_;
};

}  // namespace inkulous
