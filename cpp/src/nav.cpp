#include "1inkulous/nav.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <queue>
#include <utility>

namespace inkulous {
namespace {

double clamp_unit(double value) {
  return value < -1.0 ? -1.0 : (value > 1.0 ? 1.0 : value);
}

// Angle between two unit vectors. acos alone loses precision for nearly
// parallel vectors, which is exactly the common case here (neighbouring grid
// nodes), so use the numerically stable chord form.
double angle_between(const float* a, const float* b) {
  const double dx = static_cast<double>(a[0]) - b[0];
  const double dy = static_cast<double>(a[1]) - b[1];
  const double dz = static_cast<double>(a[2]) - b[2];
  const double chord = std::sqrt(dx * dx + dy * dy + dz * dz);
  return 2.0 * std::asin(clamp_unit(chord * 0.5));
}

// Uniform grid over direction components in [-1, 1]. 32 bins is a little finer
// than the default planet's node spacing, so a query's neighbour ring is a
// handful of nodes rather than a face of the mesh.
constexpr int kSpatialBins = 32;
// How far to walk the ring before giving up and scanning. Past this the empty
// region is wide enough that a scan of a few thousand nodes is the cheaper
// way to be exact.
constexpr int kSpatialMaxRing = 3;
// Chord gap required before an indexed hit is allowed to skip the rest of the
// graph. Float32 directions are only approximately unit, so a hair of Euclidean
// room keeps a slightly longer vector just outside the ring from winning the
// dot-product test the scan uses.
constexpr double kIndexSlack = 1e-2;

// A neighbour this close in angle to the query, seen from the node, puts the
// query on their shared edge rather than inside a triangle.
constexpr double kEdgeSine = 1e-4;
// Samples per shortest link on a clear_line walk. Barycentric weights change
// by about one per link travelled, so at six samples a bad corner can climb
// at most a twelfth of the way between two of them unseen — less than the gap
// between kRouteSupport and kStepSupport, which is what lets a walker always
// follow a leg this approved.
constexpr double kLineSamplesPerLink = 6.0;
// Hops locate() will walk before deciding the hint was nowhere near.
constexpr int kLocateMaxHops = 32;

double dot3(const double a[3], const float* b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Two unit tangents at `n`, perpendicular to it and to each other.
void tangent_basis(const float* n, double e1[3], double e2[3]) {
  // Cross with whichever axis is least aligned, so the result never vanishes.
  const double ax = std::fabs(n[0]);
  const double ay = std::fabs(n[1]);
  const double az = std::fabs(n[2]);
  double axis[3] = {0.0, 0.0, 0.0};
  if (ax <= ay && ax <= az) {
    axis[0] = 1.0;
  } else if (ay <= az) {
    axis[1] = 1.0;
  } else {
    axis[2] = 1.0;
  }
  e1[0] = n[1] * axis[2] - n[2] * axis[1];
  e1[1] = n[2] * axis[0] - n[0] * axis[2];
  e1[2] = n[0] * axis[1] - n[1] * axis[0];
  const double length = std::sqrt(e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2]);
  e1[0] /= length;
  e1[1] /= length;
  e1[2] /= length;
  e2[0] = n[1] * e1[2] - n[2] * e1[1];
  e2[1] = n[2] * e1[0] - n[0] * e1[2];
  e2[2] = n[0] * e1[1] - n[1] * e1[0];
}

// Open-list entry for the searches: smallest f first. Among equal f the one
// nearer the goal goes first — on an 8-way grid whole diamonds of nodes tie on
// f, and without the tie-break a search widens across all of them.
struct OpenEntry {
  double f;
  double h;
  std::int32_t node;
  bool operator>(const OpenEntry& other) const {
    return f > other.f || (f == other.f && (h > other.h || (h == other.h && node > other.node)));
  }
};
using OpenList = std::priority_queue<OpenEntry, std::vector<OpenEntry>, std::greater<OpenEntry>>;

double unit_angle(const double a[3], const double b[3]) {
  const double dx = a[0] - b[0];
  const double dy = a[1] - b[1];
  const double dz = a[2] - b[2];
  return 2.0 * std::asin(clamp_unit(std::sqrt(dx * dx + dy * dy + dz * dz) * 0.5));
}

bool normalized(const double in[3], double out[3]) {
  const double length = std::sqrt(in[0] * in[0] + in[1] * in[1] + in[2] * in[2]);
  if (!(length > 1e-12)) {
    return false;
  }
  out[0] = in[0] / length;
  out[1] = in[1] / length;
  out[2] = in[2] / length;
  return true;
}

int quantize_axis(double value) {
  int bin = static_cast<int>(std::floor((value + 1.0) * 0.5 * kSpatialBins));
  if (bin < 0) {
    bin = 0;
  }
  if (bin >= kSpatialBins) {
    bin = kSpatialBins - 1;
  }
  return bin;
}

std::uint32_t pack_cell(int x, int y, int z) {
  return (static_cast<std::uint32_t>(x) * kSpatialBins + static_cast<std::uint32_t>(y)) *
             kSpatialBins +
         static_cast<std::uint32_t>(z);
}

int chebyshev(int dx, int dy, int dz) {
  const int ax = dx < 0 ? -dx : dx;
  const int ay = dy < 0 ? -dy : dy;
  const int az = dz < 0 ? -dz : dz;
  return std::max(ax, std::max(ay, az));
}

// Euclidean distance from an interior point to the nearest point the ring has
// not already indexed. Cells are half-open, so a coordinate sitting on the
// high face belongs to the next cell and is outside.
double ring_clearance(double x, double y, double z, int qx, int qy, int qz, int ring) {
  const double coords[3] = {x, y, z};
  const int cells[3] = {qx, qy, qz};
  double clearance = std::numeric_limits<double>::infinity();
  for (int axis = 0; axis < 3; ++axis) {
    int lo = cells[axis] - ring;
    int hi = cells[axis] + ring;
    if (lo < 0) {
      lo = 0;
    }
    if (hi >= kSpatialBins) {
      hi = kSpatialBins - 1;
    }
    const double p = coords[axis];
    if (lo > 0) {
      const double box_lo = lo * (2.0 / kSpatialBins) - 1.0;
      clearance = std::min(clearance, p - box_lo);
    }
    if (hi < kSpatialBins - 1) {
      const double box_hi = (hi + 1) * (2.0 / kSpatialBins) - 1.0;
      clearance = std::min(clearance, box_hi - p);
    }
  }
  return clearance;
}

}  // namespace

bool NavGrid::allocate(std::int32_t node_count, std::int32_t link_count) {
  if (node_count <= 0 || link_count < 0) {
    return false;
  }

  node_count_ = node_count;
  link_count_ = link_count;
  committed_ = false;

  directions_.assign(static_cast<std::size_t>(node_count) * 3, 0.0f);
  heights_.assign(static_cast<std::size_t>(node_count), 0.0f);
  neighbor_offsets_.assign(static_cast<std::size_t>(node_count) + 1, 0);
  neighbors_.assign(static_cast<std::size_t>(link_count), 0);

  g_score_.assign(static_cast<std::size_t>(node_count), 0.0);
  came_from_.assign(static_cast<std::size_t>(node_count), -1);
  visit_stamp_.assign(static_cast<std::size_t>(node_count), 0);
  want_stamp_.assign(static_cast<std::size_t>(node_count), 0);
  toward_ = -1;
  closed_.assign(static_cast<std::size_t>(node_count), 0);
  stamp_ = 0;
  clear_spatial_index();

  return true;
}

void NavGrid::clear_spatial_index() {
  spatial_slots_.clear();
  spatial_nodes_.clear();
  spatial_ready_ = false;
}

std::size_t NavGrid::spatial_probe(std::uint32_t key) const {
  const std::size_t mask = spatial_slots_.size() - 1;
  std::size_t slot = (static_cast<std::size_t>(key) * 0x9E3779B1u) & mask;
  while (spatial_slots_[slot].count != 0 && spatial_slots_[slot].key != key) {
    slot = (slot + 1) & mask;
  }
  return slot;
}

void NavGrid::build_spatial_index() {
  clear_spatial_index();
  if (node_count_ <= 0) {
    return;
  }

  std::size_t capacity = 1;
  const std::size_t need = static_cast<std::size_t>(node_count_) * 2;
  while (capacity < need) {
    capacity <<= 1;
  }
  spatial_slots_.assign(capacity, SpatialSlot{});

  for (std::int32_t node = 0; node < node_count_; ++node) {
    const float* d = direction(node);
    const std::uint32_t key = pack_cell(quantize_axis(d[0]), quantize_axis(d[1]), quantize_axis(d[2]));
    SpatialSlot& slot = spatial_slots_[spatial_probe(key)];
    if (slot.count == 0) {
      slot.key = key;
    }
    slot.count += 1;
  }

  std::vector<std::int32_t> cursor(capacity, 0);
  std::int32_t total = 0;
  for (std::size_t i = 0; i < capacity; ++i) {
    if (spatial_slots_[i].count == 0) {
      continue;
    }
    spatial_slots_[i].start = total;
    cursor[i] = total;
    total += spatial_slots_[i].count;
  }
  spatial_nodes_.assign(static_cast<std::size_t>(total), -1);

  for (std::int32_t node = 0; node < node_count_; ++node) {
    const float* d = direction(node);
    const std::uint32_t key = pack_cell(quantize_axis(d[0]), quantize_axis(d[1]), quantize_axis(d[2]));
    const std::size_t slot = spatial_probe(key);
    spatial_nodes_[static_cast<std::size_t>(cursor[slot])] = node;
    cursor[slot] += 1;
  }

  spatial_ready_ = true;
}

bool NavGrid::offsets_valid() const {
  if (neighbor_offsets_.size() != static_cast<std::size_t>(node_count_) + 1) {
    return false;
  }
  // Must start at zero, never go backwards, and end exactly at the length of
  // the neighbour list. Anything else and find_path would walk off the end.
  if (neighbor_offsets_.front() != 0 || neighbor_offsets_.back() != link_count_) {
    return false;
  }
  for (std::size_t i = 1; i < neighbor_offsets_.size(); ++i) {
    if (neighbor_offsets_[i] < neighbor_offsets_[i - 1]) {
      return false;
    }
  }
  // The neighbour ids index the direction and height buffers everywhere the
  // graph is walked, so they are held to the same standard.
  for (const std::int32_t neighbor : neighbors_) {
    if (neighbor < 0 || neighbor >= node_count_) {
      return false;
    }
  }
  return true;
}

void NavGrid::prepare_geometry() {
  min_link_angle_ = 0.0;
  max_link_angle_ = 0.0;
  node_frames_.assign(static_cast<std::size_t>(node_count_) * 6, 0.0f);
  link_frames_.assign(static_cast<std::size_t>(link_count_) * 3, 0.0f);
  link_lengths_.assign(static_cast<std::size_t>(link_count_), 0.0);

  bool any = false;
  for (std::int32_t node = 0; node < node_count_; ++node) {
    double e1[3];
    double e2[3];
    tangent_basis(direction(node), e1, e2);
    float* frame = &node_frames_[static_cast<std::size_t>(node) * 6];
    for (int axis = 0; axis < 3; ++axis) {
      frame[axis] = static_cast<float>(e1[axis]);
      frame[3 + axis] = static_cast<float>(e2[axis]);
    }

    for (std::int32_t link = neighbor_offsets_[node]; link < neighbor_offsets_[node + 1]; ++link) {
      const float* k = direction(neighbors_[link]);
      const double u = k[0] * e1[0] + k[1] * e1[1] + k[2] * e1[2];
      const double v = k[0] * e2[0] + k[1] * e2[1] + k[2] * e2[2];
      float* out = &link_frames_[static_cast<std::size_t>(link) * 3];
      out[0] = static_cast<float>(u);
      out[1] = static_cast<float>(v);
      const double length = std::sqrt(u * u + v * v);
      out[2] = length > 1e-12 ? static_cast<float>(1.0 / length) : 0.0f;

      const double angle = angle_between(direction(node), k);
      link_lengths_[static_cast<std::size_t>(link)] = angle * planet_radius_;
      if (!(angle > 0.0)) {
        continue;
      }
      min_link_angle_ = any ? std::min(min_link_angle_, angle) : angle;
      max_link_angle_ = any ? std::max(max_link_angle_, angle) : angle;
      any = true;
    }
  }
  // A graph with no links never walks a line anywhere; any positive step will
  // do so that clear_line terminates.
  line_step_ = any ? min_link_angle_ / kLineSamplesPerLink : 1e-2;

  // Diagonals. Two nodes on opposite corners of a grid quad share exactly two
  // neighbours, the quad's other corners, one either side of the link; two
  // along a side share four. (The eight cube corners are irregular and get no
  // special treatment.)
  link_corners_.assign(static_cast<std::size_t>(link_count_) * 2, -1);
  link_corner_runs_.assign(static_cast<std::size_t>(link_count_) * 5, 0.0f);
  for (std::int32_t node = 0; node < node_count_; ++node) {
    for (std::int32_t link = neighbor_offsets_[node]; link < neighbor_offsets_[node + 1]; ++link) {
      const std::int32_t other = neighbors_[link];
      std::int32_t shared[2] = {-1, -1};
      int count = 0;
      for (std::int32_t mine = neighbor_offsets_[node]; mine < neighbor_offsets_[node + 1];
           ++mine) {
        const std::int32_t candidate = neighbors_[mine];
        for (std::int32_t theirs = neighbor_offsets_[other]; theirs < neighbor_offsets_[other + 1];
             ++theirs) {
          if (neighbors_[theirs] == candidate) {
            if (count < 2) {
              shared[count] = candidate;
            }
            ++count;
            break;
          }
        }
      }
      if (count != 2) {
        continue;
      }
      const std::int32_t c = shared[0];
      const std::int32_t d = shared[1];
      // A side on the rim of an open patch also has just two shared
      // neighbours, but both on the same side of it.
      const float* a_dir = direction(node);
      const float* b_dir = direction(other);
      const double normal[3] = {
          static_cast<double>(a_dir[1]) * b_dir[2] - static_cast<double>(a_dir[2]) * b_dir[1],
          static_cast<double>(a_dir[2]) * b_dir[0] - static_cast<double>(a_dir[0]) * b_dir[2],
          static_cast<double>(a_dir[0]) * b_dir[1] - static_cast<double>(a_dir[1]) * b_dir[0],
      };
      if (dot3(normal, direction(c)) * dot3(normal, direction(d)) >= 0.0) {
        continue;
      }
      link_corners_[static_cast<std::size_t>(link) * 2] = c;
      link_corners_[static_cast<std::size_t>(link) * 2 + 1] = d;
      float* runs = &link_corner_runs_[static_cast<std::size_t>(link) * 5];
      runs[0] = static_cast<float>(arc_length(node, c));
      runs[1] = static_cast<float>(arc_length(c, other));
      runs[2] = static_cast<float>(arc_length(node, d));
      runs[3] = static_cast<float>(arc_length(d, other));
      runs[4] = static_cast<float>(arc_length(c, d));
    }
  }
}

void NavGrid::commit(double planet_radius, double max_slope) {
  planet_radius_ = planet_radius > 0.0 ? planet_radius : 1.0;
  max_slope_ = max_slope > 0.0 ? max_slope : kDefaultMaxSlope;
  // One O(nodes) pass, once per world. Cheap next to an out-of-bounds read in
  // linear memory, which would corrupt something unrelated and far away.
  committed_ = node_count_ > 0 && offsets_valid();
  // The hash is part of committing the topology. A graph we refuse stays
  // unready and keeps no index, so a later nearest query cannot answer from
  // buckets built for a different buffer.
  if (committed_) {
    build_spatial_index();
    prepare_geometry();
  } else {
    clear_spatial_index();
  }
}

double NavGrid::arc_length(std::int32_t from, std::int32_t to) const {
  return angle_between(direction(from), direction(to)) * planet_radius_;
}

bool NavGrid::passable(std::int32_t from, std::int32_t to) const {
  return passable_run(from, to, arc_length(from, to));
}

bool NavGrid::passable_link(std::int32_t from, std::int32_t link) const {
  return passable_run(from, neighbors_[link], link_lengths_[static_cast<std::size_t>(link)]);
}

bool NavGrid::steppable(std::int32_t from, std::int32_t link) const {
  const std::int32_t to = neighbors_[link];
  if (!passable_run(from, to, link_lengths_[static_cast<std::size_t>(link)])) {
    return false;
  }
  const std::int32_t c = link_corners_[static_cast<std::size_t>(link) * 2];
  if (c < 0) {
    return true;
  }
  // A diagonal crosses the middle of its quad, which is as near the other two
  // corners as it is to its own ends. So the whole quad has to be ground a
  // follower could stand on: no cutting past a pond or the foot of a cliff.
  const std::int32_t d = link_corners_[static_cast<std::size_t>(link) * 2 + 1];
  const float* runs = &link_corner_runs_[static_cast<std::size_t>(link) * 5];
  return passable_run(from, c, runs[0]) && passable_run(c, to, runs[1]) &&
         passable_run(from, d, runs[2]) && passable_run(d, to, runs[3]) &&
         passable_run(c, d, runs[4]);
}

bool NavGrid::passable_run(std::int32_t from, std::int32_t to, double run) const {
  if (!walkable(from) || !walkable(to)) {
    return false;
  }

  const double climb = std::fabs(static_cast<double>(heights_[to]) - heights_[from]);
  // Coincident nodes should not happen on a welded grid, but a zero run would
  // divide by nothing; treat it as flat rather than as an infinite cliff.
  return run <= 0.0 ? true : climb <= max_slope_ * run;
}

std::int32_t NavGrid::nearest_linear(double nx, double ny, double nz, bool walkable_only) const {
  std::int32_t best = -1;
  double best_dot = -2.0;
  for (std::int32_t node = 0; node < node_count_; ++node) {
    if (walkable_only && !walkable(node)) {
      continue;
    }
    const float* d = direction(node);
    const double dot = static_cast<double>(d[0]) * nx + static_cast<double>(d[1]) * ny +
                       static_cast<double>(d[2]) * nz;
    // Strict `>` keeps the lowest index on a tie, matching a forward scan.
    if (dot > best_dot) {
      best_dot = dot;
      best = node;
    }
  }
  return best;
}

std::int32_t NavGrid::nearest_impl(double x, double y, double z, bool walkable_only) const {
  const double length = std::sqrt(x * x + y * y + z * z);
  if (node_count_ == 0 || !(length > 0.0)) {
    return -1;
  }

  const double nx = x / length;
  const double ny = y / length;
  const double nz = z / length;
  if (!spatial_ready_) {
    return nearest_linear(nx, ny, nz, walkable_only);
  }
  const int qx = quantize_axis(nx);
  const int qy = quantize_axis(ny);
  const int qz = quantize_axis(nz);

  std::int32_t best = -1;
  double best_dot = -2.0;
  const auto consider = [&](std::int32_t node) {
    if (walkable_only && !walkable(node)) {
      return;
    }
    const float* d = direction(node);
    const double dot = static_cast<double>(d[0]) * nx + static_cast<double>(d[1]) * ny +
                       static_cast<double>(d[2]) * nz;
    // Lowest index wins a tie, whichever cell is visited first.
    if (dot > best_dot || (dot == best_dot && node < best)) {
      best_dot = dot;
      best = node;
    }
  };

  for (int ring = 0; ring <= kSpatialMaxRing; ++ring) {
    for (int dx = -ring; dx <= ring; ++dx) {
      for (int dy = -ring; dy <= ring; ++dy) {
        for (int dz = -ring; dz <= ring; ++dz) {
          if (chebyshev(dx, dy, dz) != ring) {
            continue;
          }
          const int cx = qx + dx;
          const int cy = qy + dy;
          const int cz = qz + dz;
          if (cx < 0 || cy < 0 || cz < 0 || cx >= kSpatialBins || cy >= kSpatialBins ||
              cz >= kSpatialBins) {
            continue;
          }
          const SpatialSlot& slot = spatial_slots_[spatial_probe(pack_cell(cx, cy, cz))];
          for (std::int32_t i = 0; i < slot.count; ++i) {
            consider(spatial_nodes_[static_cast<std::size_t>(slot.start + i)]);
          }
        }
      }
    }

    if (best < 0) {
      continue;
    }
    const float* d = direction(best);
    const double ex = nx - static_cast<double>(d[0]);
    const double ey = ny - static_cast<double>(d[1]);
    const double ez = nz - static_cast<double>(d[2]);
    const double chord = std::sqrt(ex * ex + ey * ey + ez * ez);
    // Anything outside the ring is at least `clearance` away in R^3. Once the
    // best hit is closer than that by the slack, no unvisited node can beat it
    // on the dot product, and the scan is unnecessary.
    if (chord + kIndexSlack < ring_clearance(nx, ny, nz, qx, qy, qz, ring)) {
      return best;
    }
  }

  return nearest_linear(nx, ny, nz, walkable_only);
}

std::int32_t NavGrid::nearest_node(double x, double y, double z) const {
  return nearest_impl(x, y, z, false);
}

std::int32_t NavGrid::nearest_walkable_node(double x, double y, double z) const {
  return nearest_impl(x, y, z, true);
}

std::int32_t NavGrid::locate(const double dir[3], std::int32_t hint) const {
  if (!committed_) {
    return -1;
  }
  if (hint < 0 || hint >= node_count_) {
    return nearest_node(dir[0], dir[1], dir[2]);
  }

  // Comparing dot products needs no normalised query: scaling it scales them
  // all alike.
  std::int32_t current = hint;
  double best = dot3(dir, direction(current));
  for (int hop = 0; hop < kLocateMaxHops; ++hop) {
    std::int32_t next = current;
    for (std::int32_t link = neighbor_offsets_[current]; link < neighbor_offsets_[current + 1];
         ++link) {
      const std::int32_t neighbor = neighbors_[link];
      const double dot = dot3(dir, direction(neighbor));
      if (dot > best) {
        best = dot;
        next = neighbor;
      }
    }
    if (next == current) {
      return current;
    }
    current = next;
  }
  return nearest_node(dir[0], dir[1], dir[2]);
}

void NavGrid::sample(const double dir[3], std::int32_t node, SurfacePoint& out) const {
  out = SurfacePoint{};
  if (node < 0 || node >= node_count_) {
    return;
  }
  out.nodes[0] = node;
  out.weights[0] = 1.0;
  out.height = heights_[node];

  double q[3];
  if (!normalized(dir, q)) {
    return;
  }

  // Everything below happens in the tangent plane at the node, which is flat
  // enough over one cell. A great circle through the node projects to a
  // straight line through the origin there, so the graph's own links stay edges.
  const float* frame = &node_frames_[static_cast<std::size_t>(node) * 6];
  const double qu = q[0] * frame[0] + q[1] * frame[1] + q[2] * frame[2];
  const double qv = q[0] * frame[3] + q[1] * frame[4] + q[2] * frame[5];
  const double q_length = std::sqrt(qu * qu + qv * qv);
  if (q_length < 1e-12) {
    // On the node itself.
    out.on_mesh = true;
    return;
  }
  const double q_inverse = 1.0 / q_length;

  // The two neighbours either side of the query, by angle round the node: the
  // nearest one counter-clockwise of it and the nearest one clockwise.
  std::int32_t ccw = -1;
  std::int32_t cw = -1;
  std::int32_t ccw_link = -1;
  std::int32_t cw_link = -1;
  double ccw_cos = -2.0;
  double cw_cos = -2.0;
  double ccw_uv[2] = {0.0, 0.0};
  double cw_uv[2] = {0.0, 0.0};

  for (std::int32_t link = neighbor_offsets_[node]; link < neighbor_offsets_[node + 1]; ++link) {
    const std::int32_t neighbor = neighbors_[link];
    const float* k = &link_frames_[static_cast<std::size_t>(link) * 3];
    const double ku = k[0];
    const double kv = k[1];
    if (k[2] == 0.0f) {
      continue;
    }
    const double scale = k[2] * q_inverse;
    const double cross = (qu * kv - qv * ku) * scale;
    const double cosine = (qu * ku + qv * kv) * scale;

    if (std::fabs(cross) < kEdgeSine && cosine > 0.0) {
      // On the link to this neighbour: that edge alone holds the point, and
      // whatever lies either side of it has no say.
      const double t = (qu * ku + qv * kv) * k[2] * k[2];
      const double clamped = t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
      out.nodes[1] = neighbor;
      out.links[0] = link;
      out.weights[0] = 1.0 - clamped;
      out.weights[1] = clamped;
      out.height = heights_[node] * out.weights[0] + heights_[neighbor] * out.weights[1];
      out.on_mesh = t <= 1.0 + 1e-6;
      return;
    }

    if (cross > 0.0) {
      if (cosine > ccw_cos) {
        ccw_cos = cosine;
        ccw = neighbor;
        ccw_link = link;
        ccw_uv[0] = ku;
        ccw_uv[1] = kv;
      }
    } else if (cosine > cw_cos) {
      cw_cos = cosine;
      cw = neighbor;
      cw_link = link;
      cw_uv[0] = ku;
      cw_uv[1] = kv;
    }
  }

  if (ccw < 0 || cw < 0) {
    // Neighbours on one side only: a node on the rim of an open patch, with the
    // query beyond it.
    return;
  }

  // q = s * a + t * b, solved in the plane.
  const double det = ccw_uv[0] * cw_uv[1] - ccw_uv[1] * cw_uv[0];
  if (std::fabs(det) < 1e-18) {
    return;
  }
  double s = (qu * cw_uv[1] - qv * cw_uv[0]) / det;
  double t = (ccw_uv[0] * qv - ccw_uv[1] * qu) / det;
  if (s < 0.0 || t < 0.0) {
    // The two neighbours span half a turn or more, so no triangle of the fan
    // holds the query: the rim again.
    return;
  }
  const double outside = s + t;
  out.on_mesh = outside <= 1.0 + 1e-6;
  if (outside > 1.0) {
    // Past the far edge of the fan, which locate() should not allow. Clamp onto
    // that edge rather than extrapolate.
    s /= outside;
    t /= outside;
  }

  out.nodes[1] = ccw;
  out.nodes[2] = cw;
  out.links[0] = ccw_link;
  out.links[1] = cw_link;
  out.weights[0] = 1.0 - s - t;
  out.weights[1] = s;
  out.weights[2] = t;
  out.height = heights_[node] * out.weights[0] + heights_[ccw] * s + heights_[cw] * t;
}

bool NavGrid::passable_near(std::int32_t from, std::int32_t to) const {
  for (std::int32_t link = neighbor_offsets_[from]; link < neighbor_offsets_[from + 1]; ++link) {
    if (neighbors_[link] == to) {
      return passable_link(from, link);
    }
  }
  return passable(from, to);
}

bool NavGrid::standable(const SurfacePoint& point, double support) const {
  if (!point.on_mesh) {
    return false;
  }

  bool held[3];
  for (int i = 0; i < 3; ++i) {
    held[i] = point.nodes[i] >= 0 && point.weights[i] > support;
    if (held[i] && !walkable(point.nodes[i])) {
      return false;
    }
  }
  // The centre to each neighbour is a link whose index sample() kept; the two
  // neighbours are next to each other round the fan, so usually linked too.
  for (int i = 1; i < 3; ++i) {
    if (held[0] && held[i] && !passable_link(point.nodes[0], point.links[i - 1])) {
      return false;
    }
  }
  if (held[1] && held[2] && !passable_near(point.nodes[1], point.nodes[2])) {
    return false;
  }
  return held[0] || held[1] || held[2];
}

bool NavGrid::footing(const double dir[3],
                      std::int32_t node,
                      double support,
                      SurfacePoint& out) const {
  sample(dir, node, out);
  return footing_sampled(dir, support, out);
}

bool NavGrid::footing_sampled(const double dir[3], double support, SurfacePoint& out) const {
  if (standable(out, support)) {
    return true;
  }
  // Each node's fan splits the quads round it along its own diagonals, so near
  // the middle of a quad the reading flips between the two splits as the
  // nearest corner changes. The neighbours either side of the point are the
  // other diagonal's ends; if either split is good ground, so is the point.
  SurfacePoint other;
  for (int corner = 1; corner < 3; ++corner) {
    const std::int32_t neighbor = out.nodes[corner];
    if (neighbor < 0) {
      continue;
    }
    sample(dir, neighbor, other);
    if (standable(other, support)) {
      out = other;
      return true;
    }
  }
  return false;
}

bool NavGrid::clear_line(const double from[3], std::int32_t from_node, const double to[3]) const {
  if (!committed_) {
    return false;
  }

  double a[3];
  double b[3];
  if (!normalized(from, a) || !normalized(to, b)) {
    return false;
  }

  const double angle = unit_angle(a, b);
  if (angle > 3.0) {
    // Nearly antipodal, where the great circle is barely defined. No order
    // sends anyone that far in one leg.
    return false;
  }

  // Unit tangent at `a` towards `b`.
  const double along = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  double tangent[3] = {b[0] - a[0] * along, b[1] - a[1] * along, b[2] - a[2] * along};
  if (!normalized(tangent, tangent)) {
    // Same point: nothing between them to test but the end itself.
    tangent[0] = 0.0;
    tangent[1] = 0.0;
    tangent[2] = 0.0;
  }

  const int steps = std::max(1, static_cast<int>(std::ceil(angle / line_step_)));
  // Each sample is the last one turned a fixed angle further along the circle,
  // with the tangent turned with it.
  const double turn_cos = std::cos(angle / steps);
  const double turn_sin = std::sin(angle / steps);
  double p[3] = {a[0], a[1], a[2]};
  std::int32_t node = from_node;
  SurfacePoint point;
  // Consecutive samples mostly land on the same triangle. Its verdict depends
  // only on which corners carry weight, so the slope tests are skipped while
  // that set stays the same.
  std::int32_t last_support[3] = {-2, -2, -2};
  for (int i = 1; i <= steps; ++i) {
    if (i == steps) {
      p[0] = b[0];
      p[1] = b[1];
      p[2] = b[2];
    } else {
      for (int axis = 0; axis < 3; ++axis) {
        const double point_axis = p[axis];
        p[axis] = point_axis * turn_cos + tangent[axis] * turn_sin;
        tangent[axis] = tangent[axis] * turn_cos - point_axis * turn_sin;
      }
    }
    node = locate(p, node);
    sample(p, node, point);
    std::int32_t support[3];
    for (int corner = 0; corner < 3; ++corner) {
      support[corner] = point.weights[corner] > kRouteSupport ? point.nodes[corner] : -1;
    }
    // Sorted, so the same triangle seen from either of its corners matches.
    if (support[0] > support[1]) std::swap(support[0], support[1]);
    if (support[1] > support[2]) std::swap(support[1], support[2]);
    if (support[0] > support[1]) std::swap(support[0], support[1]);
    if (support[0] == last_support[0] && support[1] == last_support[1] &&
        support[2] == last_support[2]) {
      continue;
    }
    if (!footing_sampled(p, kRouteSupport, point)) {
      return false;
    }
    last_support[0] = support[0];
    last_support[1] = support[1];
    last_support[2] = support[2];
  }
  return true;
}

void NavGrid::next_stamp() {
  ++stamp_;
  if (stamp_ == 0) {
    // Wrapped after 4 billion searches: the stale stamps would read as
    // current, so clear them once and carry on.
    std::fill(visit_stamp_.begin(), visit_stamp_.end(), 0);
    std::fill(want_stamp_.begin(), want_stamp_.end(), 0);
    stamp_ = 1;
  }
}

bool NavGrid::search_toward(std::int32_t to, const std::vector<std::int32_t>& starts) {
  toward_ = -1;
  if (!committed_ || to < 0 || to >= node_count_ || !walkable(to)) {
    return false;
  }

  next_stamp();
  toward_ = to;
  toward_stamp_ = stamp_;

  std::int32_t wanted = 0;
  for (const std::int32_t start : starts) {
    if (start < 0 || start >= node_count_ || want_stamp_[start] == stamp_) {
      continue;
    }
    want_stamp_[start] = stamp_;
    ++wanted;
  }

  // Dijkstra outwards from the goal. Steps cost the same both ways, so the
  // distance a node settles at is its distance *to* the goal, and the node it
  // was reached from is its next step there. No heuristic: there is no single
  // place being searched for, only a set to cover.
  OpenList open;
  g_score_[to] = 0.0;
  came_from_[to] = -1;
  visit_stamp_[to] = stamp_;
  closed_[to] = 0;
  open.push(OpenEntry{0.0, 0.0, to});

  while (!open.empty() && wanted > 0) {
    const std::int32_t current = open.top().node;
    open.pop();

    if (closed_[current] == 1 && visit_stamp_[current] == stamp_) {
      continue;
    }
    closed_[current] = 1;
    if (want_stamp_[current] == stamp_) {
      --wanted;
    }

    for (std::int32_t link = neighbor_offsets_[current]; link < neighbor_offsets_[current + 1];
         ++link) {
      const std::int32_t next = neighbors_[link];
      const double run = link_lengths_[static_cast<std::size_t>(link)];
      if (!steppable(current, link)) {
        continue;
      }
      if (visit_stamp_[next] == stamp_ && closed_[next] == 1) {
        continue;
      }
      const double climb = static_cast<double>(heights_[next]) - heights_[current];
      const double tentative = g_score_[current] + std::sqrt(run * run + climb * climb);
      if (visit_stamp_[next] == stamp_ && tentative >= g_score_[next]) {
        continue;
      }
      visit_stamp_[next] = stamp_;
      closed_[next] = 0;
      g_score_[next] = tentative;
      came_from_[next] = current;
      open.push(OpenEntry{tentative, 0.0, next});
    }
  }
  return true;
}

bool NavGrid::path_toward(std::int32_t from, std::vector<std::int32_t>& out) const {
  out.clear();
  // Only good until the next search reuses the scratch.
  if (toward_ < 0 || toward_stamp_ != stamp_ || from < 0 || from >= node_count_) {
    return false;
  }
  if (from == toward_) {
    return true;
  }
  if (visit_stamp_[from] != stamp_ || closed_[from] != 1) {
    return false;
  }
  for (std::int32_t node = came_from_[from]; node >= 0; node = came_from_[node]) {
    out.push_back(node);
    if (node == toward_) {
      return true;
    }
  }
  return false;
}

double NavGrid::distance_toward(std::int32_t from) const {
  if (toward_ < 0 || toward_stamp_ != stamp_ || from < 0 || from >= node_count_ ||
      visit_stamp_[from] != stamp_ || closed_[from] != 1) {
    return std::numeric_limits<double>::infinity();
  }
  return g_score_[from];
}

bool NavGrid::find_path(std::int32_t from,
                        std::int32_t to,
                        std::vector<std::int32_t>& out) {
  out.clear();

  if (!committed_ || from < 0 || to < 0 || from >= node_count_ || to >= node_count_) {
    return false;
  }
  if (from == to) {
    return true;
  }
  if (!walkable(from) || !walkable(to)) {
    return false;
  }

  next_stamp();

  const float* goal = direction(to);
  const auto heuristic = [&](std::int32_t node) {
    return angle_between(direction(node), goal) * planet_radius_;
  };

  OpenList open;

  g_score_[from] = 0.0;
  came_from_[from] = -1;
  visit_stamp_[from] = stamp_;
  closed_[from] = 0;
  const double start_h = heuristic(from);
  open.push(OpenEntry{start_h, start_h, from});

  bool found = false;
  while (!open.empty()) {
    const std::int32_t current = open.top().node;
    open.pop();

    if (closed_[current] == 1 && visit_stamp_[current] == stamp_) {
      // A cheaper route to this node was expanded first; this entry is stale.
      continue;
    }
    closed_[current] = 1;

    if (current == to) {
      found = true;
      break;
    }

    const std::int32_t begin = neighbor_offsets_[current];
    const std::int32_t end = neighbor_offsets_[current + 1];
    for (std::int32_t link = begin; link < end; ++link) {
      const std::int32_t next = neighbors_[link];
      // The run is the link's own, fixed at commit; only the climb is live.
      const double run = link_lengths_[static_cast<std::size_t>(link)];
      if (!steppable(current, link)) {
        continue;
      }
      if (visit_stamp_[next] == stamp_ && closed_[next] == 1) {
        continue;
      }

      // True path length over the ground, so a detour round a hill can win
      // against climbing it. The heuristic ignores climb and so stays
      // admissible.
      const double climb = static_cast<double>(heights_[next]) - heights_[current];
      const double tentative = g_score_[current] + std::sqrt(run * run + climb * climb);

      if (visit_stamp_[next] == stamp_ && tentative >= g_score_[next]) {
        continue;
      }

      visit_stamp_[next] = stamp_;
      closed_[next] = 0;
      g_score_[next] = tentative;
      came_from_[next] = current;
      const double h = heuristic(next);
      open.push(OpenEntry{tentative + h, h, next});
    }
  }

  if (!found) {
    return false;
  }

  for (std::int32_t node = to; node != from && node >= 0; node = came_from_[node]) {
    out.push_back(node);
  }
  std::reverse(out.begin(), out.end());
  return true;
}

void NavGrid::smooth_path(const NavPoint& start,
                          const std::vector<std::int32_t>& nodes,
                          const NavPoint& goal,
                          std::vector<NavPoint>& out) {
  out.clear();

  // Candidates in walking order. Each is reachable from the one before it
  // without any test: the start lies in its node's cell, consecutive route
  // nodes share a link A* already accepted, and the goal lies in the last
  // node's cell.
  std::vector<NavPoint>& candidates = smooth_scratch_;
  candidates.clear();

  const auto push_node = [&](std::int32_t node) {
    NavPoint point;
    const float* d = direction(node);
    point.dir[0] = d[0];
    point.dir[1] = d[1];
    point.dir[2] = d[2];
    point.node = node;
    candidates.push_back(point);
  };
  const auto same_place = [](const double a[3], const double b[3]) {
    return unit_angle(a, b) < 1e-9;
  };

  // The node the route leaves from: the start's own, unless the route begins
  // somewhere else (an empty route has nothing to begin from).
  const std::int32_t first = start.node;
  if (first >= 0) {
    const float* d = direction(first);
    const double centre[3] = {d[0], d[1], d[2]};
    if (!same_place(start.dir, centre)) {
      push_node(first);
    }
  }
  for (const std::int32_t node : nodes) {
    push_node(node);
  }
  if (candidates.empty() || !same_place(candidates.back().dir, goal.dir)) {
    candidates.push_back(goal);
  }

  // Greedy string-pull: from each anchor, jump to the furthest candidate it
  // can see. Sight is close enough to monotonic along a route that a bisection
  // finds that candidate in a handful of line walks instead of one per node,
  // and anything it settles on has been tested, so a non-monotonic stretch only
  // costs a waypoint, never a bad leg.
  NavPoint anchor = start;
  std::size_t next = 0;
  const std::size_t last = candidates.size() - 1;
  while (next <= last) {
    std::size_t reach = next;
    if (next < last) {
      if (clear_line(anchor.dir, anchor.node, candidates[last].dir)) {
        reach = last;
      } else {
        std::size_t seen = next;
        std::size_t blocked = last;
        while (blocked - seen > 1) {
          const std::size_t mid = seen + (blocked - seen) / 2;
          if (clear_line(anchor.dir, anchor.node, candidates[mid].dir)) {
            seen = mid;
          } else {
            blocked = mid;
          }
        }
        reach = seen;
      }
    }
    out.push_back(candidates[reach]);
    anchor = candidates[reach];
    next = reach + 1;
  }
}

}  // namespace inkulous
