#pragma once

// Test fixtures: a small cube-sphere planet to run the core on, built the way
// src/game/navGraph.ts builds the real one — welded grid vertices, 8-way links,
// sorted neighbours — so the graph has the seams and corner nodes the game's
// does, without any of TypeScript.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <tuple>
#include <vector>

#include <doctest/doctest.h>

#include "1inkulous/core.hpp"

namespace testing_support {

using Vec3 = std::array<double, 3>;

inline Vec3 normalized(Vec3 v) {
  const double length = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return {v[0] / length, v[1] / length, v[2] / length};
}

inline double angle(const double* a, const double* b) {
  const double dx = a[0] - b[0];
  const double dy = a[1] - b[1];
  const double dz = a[2] - b[2];
  return 2.0 * std::asin(std::min(1.0, std::sqrt(dx * dx + dy * dy + dz * dz) * 0.5));
}
inline double angle(const Vec3& a, const Vec3& b) { return angle(a.data(), b.data()); }

// `from` moved `distance` radians along the great circle towards `toward`.
inline Vec3 step_towards(const Vec3& from, const Vec3& toward, double distance) {
  double along = from[0] * toward[0] + from[1] * toward[1] + from[2] * toward[2];
  Vec3 tangent = {toward[0] - from[0] * along, toward[1] - from[1] * along,
                  toward[2] - from[2] * along};
  tangent = normalized(tangent);
  return normalized({from[0] * std::cos(distance) + tangent[0] * std::sin(distance),
                     from[1] * std::cos(distance) + tangent[1] * std::sin(distance),
                     from[2] * std::cos(distance) + tangent[2] * std::sin(distance)});
}

constexpr double kRadius = 1.0;
constexpr double kMaxHeight = 0.06;
// Dry ground a third of the way up the ceiling, as the TypeScript tests use.
constexpr float kLand = static_cast<float>(kMaxHeight / 3.0);

// The graph's data, kept so a test can read the directions it built.
struct Graph {
  std::int32_t node_count = 0;
  std::vector<float> directions;
  std::vector<std::int32_t> offsets;
  std::vector<std::int32_t> neighbors;
};

inline Graph build_graph(int resolution) {
  struct Face {
    Vec3 normal, right, up;
  };
  const Face faces[6] = {
      {{1, 0, 0}, {0, 0, -1}, {0, 1, 0}}, {{-1, 0, 0}, {0, 0, 1}, {0, 1, 0}},
      {{0, 1, 0}, {1, 0, 0}, {0, 0, -1}}, {{0, -1, 0}, {1, 0, 0}, {0, 0, 1}},
      {{0, 0, 1}, {1, 0, 0}, {0, 1, 0}},  {{0, 0, -1}, {-1, 0, 0}, {0, 1, 0}},
  };
  const int stride = resolution + 1;
  const int per_face = stride * stride;

  Graph graph;
  std::map<std::tuple<long, long, long>, std::int32_t> weld;
  std::vector<std::int32_t> weld_id(static_cast<std::size_t>(6 * per_face));
  for (int face = 0; face < 6; ++face) {
    for (int iy = 0; iy < stride; ++iy) {
      for (int ix = 0; ix < stride; ++ix) {
        const double a = 2.0 * ix / resolution - 1.0;
        const double b = 2.0 * iy / resolution - 1.0;
        const Face& f = faces[face];
        const Vec3 p = normalized({f.normal[0] + a * f.right[0] + b * f.up[0],
                                   f.normal[1] + a * f.right[1] + b * f.up[1],
                                   f.normal[2] + a * f.right[2] + b * f.up[2]});
        const auto key = std::make_tuple(std::lround(p[0] * 1e6), std::lround(p[1] * 1e6),
                                         std::lround(p[2] * 1e6));
        auto found = weld.find(key);
        if (found == weld.end()) {
          found = weld.emplace(key, graph.node_count++).first;
          for (double c : p) graph.directions.push_back(static_cast<float>(c));
        }
        weld_id[static_cast<std::size_t>(face * per_face + iy * stride + ix)] = found->second;
      }
    }
  }

  std::vector<std::vector<std::int32_t>> adjacency(static_cast<std::size_t>(graph.node_count));
  for (int face = 0; face < 6; ++face) {
    for (int iy = 0; iy < stride; ++iy) {
      for (int ix = 0; ix < stride; ++ix) {
        const std::int32_t node =
            weld_id[static_cast<std::size_t>(face * per_face + iy * stride + ix)];
        for (int dy = -1; dy <= 1; ++dy) {
          for (int dx = -1; dx <= 1; ++dx) {
            const int nx = ix + dx;
            const int ny = iy + dy;
            if ((dx == 0 && dy == 0) || nx < 0 || ny < 0 || nx >= stride || ny >= stride) continue;
            const std::int32_t other =
                weld_id[static_cast<std::size_t>(face * per_face + ny * stride + nx)];
            if (other != node) adjacency[static_cast<std::size_t>(node)].push_back(other);
          }
        }
      }
    }
  }
  graph.offsets.assign(static_cast<std::size_t>(graph.node_count) + 1, 0);
  for (std::size_t node = 0; node < adjacency.size(); ++node) {
    auto& list = adjacency[node];
    std::sort(list.begin(), list.end());
    list.erase(std::unique(list.begin(), list.end()), list.end());
    graph.offsets[node + 1] = graph.offsets[node] + static_cast<std::int32_t>(list.size());
    graph.neighbors.insert(graph.neighbors.end(), list.begin(), list.end());
  }
  return graph;
}

// `value` within `relative` (0.1 = 10%) of `expected`. doctest's own
// Approx().epsilon() is relative to 1 + |value|, which for numbers this small is
// close to absolute and far looser than it reads.
inline bool within(double value, double expected, double relative) {
  return std::fabs(value - expected) <= relative * std::fabs(expected);
}

// Height of the ground under a unit direction.
using HeightFn = std::function<double(const Vec3&)>;

// A simulation with a committed planet on it. Not movable: the core's sets hold
// pointers into the Simulation, so a test builds one on its own stack.
class World {
 public:
  explicit World(int resolution = 12, const HeightFn& height = nullptr, double max_slope = 0.0)
      : graph(build_graph(resolution)) {
    auto& nav = sim.nav();
    REQUIRE(nav.allocate(graph.node_count, static_cast<std::int32_t>(graph.neighbors.size())));
    std::copy(graph.directions.begin(), graph.directions.end(), nav.directions());
    std::copy(graph.offsets.begin(), graph.offsets.end(), nav.neighbor_offsets());
    std::copy(graph.neighbors.begin(), graph.neighbors.end(), nav.neighbors());
    for (std::int32_t node = 0; node < graph.node_count; ++node) {
      const std::size_t base = static_cast<std::size_t>(node) * 3;
      const Vec3 dir = {graph.directions[base], graph.directions[base + 1],
                        graph.directions[base + 2]};
      nav.heights()[node] = height ? static_cast<float>(height(dir)) : kLand;
    }
    nav.commit(kRadius, max_slope);
    sim.terrain().set_max_height(kMaxHeight);
  }

  // Runs whole fixed steps for `seconds` of simulated time.
  void run(double seconds) {
    const int steps = static_cast<int>(std::lround(seconds * 1000.0 / sim.step_ms()));
    for (int i = 0; i < steps; ++i) sim.advance(sim.step_ms());
  }

  // Runs until `done()` or `max_seconds`; returns the seconds it took.
  template <typename Done>
  double run_until(double max_seconds, Done&& done) {
    const int limit = static_cast<int>(std::lround(max_seconds * 1000.0 / sim.step_ms()));
    int steps = 0;
    while (steps < limit && !done()) {
      sim.advance(sim.step_ms());
      ++steps;
    }
    return steps * sim.step_ms() / 1000.0;
  }

  Vec3 where(std::int32_t follower) {
    const double* d = sim.followers().direction(follower);
    return {d[0], d[1], d[2]};
  }

  inkulous::Simulation sim;
  Graph graph;
};

}  // namespace testing_support
