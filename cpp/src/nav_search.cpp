// Route search over the nav graph: A* between two nodes, one Dijkstra out from
// a goal that serves a whole group order, and string-pulling a node route into
// straight legs. The graph itself — building, passability, nearest-node and
// surface queries — is in nav.cpp.

#include "1inkulous/nav.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <queue>
#include <utility>

#include "nav_internal.hpp"

namespace inkulous {

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
    if (start < 0 || start >= node_count_ || want_stamp_[idx(start)] == stamp_) {
      continue;
    }
    want_stamp_[idx(start)] = stamp_;
    ++wanted;
  }

  // Dijkstra outwards from the goal. Steps cost the same both ways, so the
  // distance a node settles at is its distance *to* the goal, and the node it
  // was reached from is its next step there. No heuristic: there is no single
  // place being searched for, only a set to cover.
  OpenList open;
  g_score_[idx(to)] = 0.0;
  came_from_[idx(to)] = -1;
  visit_stamp_[idx(to)] = stamp_;
  closed_[idx(to)] = 0;
  open.push(OpenEntry{0.0, 0.0, to});

  while (!open.empty() && wanted > 0) {
    const std::int32_t current = open.top().node;
    open.pop();

    if (closed_[idx(current)] == 1 && visit_stamp_[idx(current)] == stamp_) {
      continue;
    }
    closed_[idx(current)] = 1;
    if (want_stamp_[idx(current)] == stamp_) {
      --wanted;
    }

    for (std::int32_t link = neighbor_offsets_[idx(current)];
         link < neighbor_offsets_[idx(current + 1)]; ++link) {
      const std::int32_t next = neighbors_[idx(link)];
      const double run = link_lengths_[static_cast<std::size_t>(link)];
      if (!steppable(current, link)) {
        continue;
      }
      if (visit_stamp_[idx(next)] == stamp_ && closed_[idx(next)] == 1) {
        continue;
      }
      const double climb = static_cast<double>(heights_[idx(next)]) - heights_[idx(current)];
      const double tentative = g_score_[idx(current)] + std::sqrt(run * run + climb * climb);
      if (visit_stamp_[idx(next)] == stamp_ && tentative >= g_score_[idx(next)]) {
        continue;
      }
      visit_stamp_[idx(next)] = stamp_;
      closed_[idx(next)] = 0;
      g_score_[idx(next)] = tentative;
      came_from_[idx(next)] = current;
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
  if (visit_stamp_[idx(from)] != stamp_ || closed_[idx(from)] != 1) {
    return false;
  }
  for (std::int32_t node = came_from_[idx(from)]; node >= 0; node = came_from_[idx(node)]) {
    out.push_back(node);
    if (node == toward_) {
      return true;
    }
  }
  return false;
}

double NavGrid::distance_toward(std::int32_t from) const {
  if (toward_ < 0 || toward_stamp_ != stamp_ || from < 0 || from >= node_count_ ||
      visit_stamp_[idx(from)] != stamp_ || closed_[idx(from)] != 1) {
    return std::numeric_limits<double>::infinity();
  }
  return g_score_[idx(from)];
}

bool NavGrid::find_path(std::int32_t from, std::int32_t to, std::vector<std::int32_t>& out) {
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

  g_score_[idx(from)] = 0.0;
  came_from_[idx(from)] = -1;
  visit_stamp_[idx(from)] = stamp_;
  closed_[idx(from)] = 0;
  const double start_h = heuristic(from);
  open.push(OpenEntry{start_h, start_h, from});

  bool found = false;
  while (!open.empty()) {
    const std::int32_t current = open.top().node;
    open.pop();

    if (closed_[idx(current)] == 1 && visit_stamp_[idx(current)] == stamp_) {
      // A cheaper route to this node was expanded first; this entry is stale.
      continue;
    }
    closed_[idx(current)] = 1;

    if (current == to) {
      found = true;
      break;
    }

    const std::int32_t begin = neighbor_offsets_[idx(current)];
    const std::int32_t end = neighbor_offsets_[idx(current + 1)];
    for (std::int32_t link = begin; link < end; ++link) {
      const std::int32_t next = neighbors_[idx(link)];
      // The run is the link's own, fixed at commit; only the climb is live.
      const double run = link_lengths_[static_cast<std::size_t>(link)];
      if (!steppable(current, link)) {
        continue;
      }
      if (visit_stamp_[idx(next)] == stamp_ && closed_[idx(next)] == 1) {
        continue;
      }

      // True path length over the ground, so a detour round a hill can win
      // against climbing it. The heuristic ignores climb and so stays
      // admissible.
      const double climb = static_cast<double>(heights_[idx(next)]) - heights_[idx(current)];
      const double tentative = g_score_[idx(current)] + std::sqrt(run * run + climb * climb);

      if (visit_stamp_[idx(next)] == stamp_ && tentative >= g_score_[idx(next)]) {
        continue;
      }

      visit_stamp_[idx(next)] = stamp_;
      closed_[idx(next)] = 0;
      g_score_[idx(next)] = tentative;
      came_from_[idx(next)] = current;
      const double h = heuristic(next);
      open.push(OpenEntry{tentative + h, h, next});
    }
  }

  if (!found) {
    return false;
  }

  for (std::int32_t node = to; node != from && node >= 0; node = came_from_[idx(node)]) {
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
