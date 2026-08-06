#include "1inkulous/nav.hpp"

#include <algorithm>
#include <cmath>
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

  return true;
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

std::int32_t NavGrid::nearest_node(double x, double y, double z) const {
  const double length = std::sqrt(x * x + y * y + z * z);
  if (node_count_ == 0 || !(length > 0.0)) {
    return -1;
  }

  const double nx = x / length;
  const double ny = y / length;
  const double nz = z / length;

  std::int32_t best = -1;
  double best_dot = -2.0;
  for (std::int32_t node = 0; node < node_count_; ++node) {
    const float* d = direction(node);
    const double dot = d[0] * nx + d[1] * ny + d[2] * nz;
    if (dot > best_dot) {
      best_dot = dot;
      best = node;
    }
  }
  return best;
}

std::int32_t NavGrid::nearest_walkable_node(double x, double y, double z) const {
  const double length = std::sqrt(x * x + y * y + z * z);
  if (node_count_ == 0 || !(length > 0.0)) {
    return -1;
  }

  const double nx = x / length;
  const double ny = y / length;
  const double nz = z / length;

  std::int32_t best = -1;
  double best_dot = -2.0;
  for (std::int32_t node = 0; node < node_count_; ++node) {
    if (!walkable(node)) {
      continue;
    }
    const float* d = direction(node);
    const double dot = d[0] * nx + d[1] * ny + d[2] * nz;
    if (dot > best_dot) {
      best_dot = dot;
      best = node;
    }
  }
  return best;
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
