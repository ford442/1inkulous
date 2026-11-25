#pragma once

// Private to nav.cpp and nav_search.cpp: the angle helpers and the open list the
// graph queries and the searches share. Not part of the core's interface.

#include <cmath>
#include <cstdint>
#include <functional>
#include <queue>
#include <vector>

namespace inkulous {
namespace detail {

inline double clamp_unit(double value) { return value < -1.0 ? -1.0 : (value > 1.0 ? 1.0 : value); }

// Angle between two unit vectors. acos alone loses precision for nearly
// parallel vectors, which is exactly the common case here (neighbouring grid
// nodes), so use the numerically stable chord form.
inline double angle_between(const float* a, const float* b) {
  const double dx = static_cast<double>(a[0]) - b[0];
  const double dy = static_cast<double>(a[1]) - b[1];
  const double dz = static_cast<double>(a[2]) - b[2];
  const double chord = std::sqrt(dx * dx + dy * dy + dz * dz);
  return 2.0 * std::asin(clamp_unit(chord * 0.5));
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
using OpenList = std::priority_queue<OpenEntry, std::vector<OpenEntry>, std::greater<>>;

inline double unit_angle(const double a[3], const double b[3]) {
  const double dx = a[0] - b[0];
  const double dy = a[1] - b[1];
  const double dz = a[2] - b[2];
  return 2.0 * std::asin(clamp_unit(std::sqrt(dx * dx + dy * dy + dz * dz) * 0.5));
}

}  // namespace detail

using namespace detail;

}  // namespace inkulous
