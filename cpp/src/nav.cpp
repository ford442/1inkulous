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
  return true;
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
  } else {
    clear_spatial_index();
  }
}

double NavGrid::arc_length(std::int32_t from, std::int32_t to) const {
  return angle_between(direction(from), direction(to)) * planet_radius_;
}

bool NavGrid::passable(std::int32_t from, std::int32_t to) const {
  if (!walkable(from) || !walkable(to)) {
    return false;
  }

  const double climb = std::fabs(static_cast<double>(heights_[to]) - heights_[from]);
  const double run = arc_length(from, to);
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

  ++stamp_;
  if (stamp_ == 0) {
    // Wrapped after 4 billion searches: the stale stamps below would read as
    // current, so clear them once and carry on.
    std::fill(visit_stamp_.begin(), visit_stamp_.end(), 0);
    stamp_ = 1;
  }

  const float* goal = direction(to);
  const auto heuristic = [&](std::int32_t node) {
    return angle_between(direction(node), goal) * planet_radius_;
  };

  // (f-score, node), smallest first.
  using Entry = std::pair<double, std::int32_t>;
  std::priority_queue<Entry, std::vector<Entry>, std::greater<Entry>> open;

  g_score_[from] = 0.0;
  came_from_[from] = -1;
  visit_stamp_[from] = stamp_;
  closed_[from] = 0;
  open.emplace(heuristic(from), from);

  bool found = false;
  while (!open.empty()) {
    const std::int32_t current = open.top().second;
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
      if (next < 0 || next >= node_count_ || !passable(current, next)) {
        continue;
      }
      if (visit_stamp_[next] == stamp_ && closed_[next] == 1) {
        continue;
      }

      // True path length over the ground, so a detour round a hill can win
      // against climbing it. The heuristic ignores climb and so stays
      // admissible.
      const double run = arc_length(current, next);
      const double climb = static_cast<double>(heights_[next]) - heights_[current];
      const double tentative = g_score_[current] + std::sqrt(run * run + climb * climb);

      if (visit_stamp_[next] == stamp_ && tentative >= g_score_[next]) {
        continue;
      }

      visit_stamp_[next] = stamp_;
      closed_[next] = 0;
      g_score_[next] = tentative;
      came_from_[next] = current;
      open.emplace(tentative + heuristic(next), next);
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

}  // namespace inkulous
