#pragma once

// Private to the follower translation units (followers.cpp, follower_*.cpp):
// the tuning constants and vector helpers they share, and the neighbour-index
// walk that steering and combat both use. Not part of the core's interface.

#include <cmath>
#include <cstddef>
#include <cstdint>

#include "1inkulous/followers.hpp"

namespace inkulous {
namespace detail {

// Formation spacing for a group order: a shade over the separation distance,
// so a group that has arrived stands still instead of nudging itself apart.
constexpr double kSlotSpacing = kFollowerSpacing * 1.15;
// How far ahead a walker looks for someone to step round, in world units.
constexpr double kAvoidReach = kFollowerSpacing * 3.0;
// How hard a walker swerves for someone dead ahead and close, as sideways
// motion per unit forward. Capped so it always keeps making headway.
constexpr double kAvoidGain = 1.5;
constexpr double kMaxSwerve = 2.0;
// Within this of a corner, a walker checks whether it can already see the
// waypoint after it, so a crowd does not have to file through the exact point.
// While it cannot, it looks again this often.
constexpr double kCornerReach = kFollowerSpacing * 2.0;
constexpr double kCornerRetry = 0.25;
// Directions a blocked walker tries before giving its route up: this far
// either side of straight on, in radians.
constexpr double kSlideAngles[] = {0.5, 1.0};
constexpr int kSlideTurns = 4;
// Largest separation push applied in one step, in world units. A stack of
// followers comes apart over a second or so rather than in one jump.
constexpr double kMaxPush = kFollowerSpacing * 0.5;
// How far an arrival may be nudged off the spot it was given, in world units.
// Inside this it still reads as standing on that point; past it the weld
// belongs to whoever the order actually sent there.
constexpr double kGoalHold = 0.009;
// Share of an overlap a walker takes when it meets someone standing still:
// none. The bystander shuffles aside if the ground lets it, and if it is
// pinned — on a spit of land, say — the walker squeezes past rather than be
// held up behind someone who is never going to move.
constexpr double kWalkerShare = 0.0;
// A walker that has not got closer to its waypoint for this long is stuck.
constexpr double kStallSeconds = 1.5;
// How far back along the group's routes to look for the way they arrive.
constexpr std::size_t kApproachNodes = 4;
// Fixed steps a walker may be refused a step by another body before it
// repaths once from its anchor node. Eight steps is under half a second.
constexpr std::int32_t kOccupancyBlocks = 8;
// Closer than this, two followers are still a stack: separation peels them,
// and the segment test does not treat the shared start as occupied.
constexpr double kStackDistance = 1e-3;
// A body this close to the step ahead owns that ground. Wider than a stack,
// narrower than a passing gap, so two walkers can still step round each other.
constexpr double kOccupancyRadius = kFollowerSpacing * 0.45;
// How hard a file spreads sideways as it nears a waypoint, per lane, scaled
// by how close that waypoint is. Clamped with the rest of the swerve.
constexpr double kLaneGain = 0.85;
// A duplicate slot may slide onto a free node this far from where it was
// packed. Further than that, the formation stays dense and shares the cell.
constexpr double kClaimReach = kFollowerSpacing * 4.0;
// Re-routes in a row, with no waypoint reached in between, before a stuck
// walker gives up; the least time between two of them; and how many times
// in all one order may stall before it is abandoned, so a walker cannot circle
// between two waypoints for ever.
constexpr std::int32_t kMaxRepaths = 3;
constexpr std::int32_t kMaxStalls = 8;
constexpr double kRepathCooldown = 1.0;
// A walker with someone this close is in a crowd, and being stuck there is
// queueing rather than being lost. It waits this long before re-routing.
constexpr double kCrowdedReach = kFollowerSpacing * 1.25;
constexpr double kJamPatience = 20.0;
// Walkers heading within about 45 degrees of each other are going the same
// way: the one behind keeps its distance instead of stepping round.
constexpr double kQueueAlike = 0.7;
// Getting closer by less than this share of a step does not count as progress.
constexpr double kProgressFraction = 0.25;
// Followers on exactly the same spot are pushed apart along a direction picked
// from their ids, spread round the circle by the golden angle.
constexpr double kGoldenAngle = 2.39996322972865332;

// The fight reuses the step's neighbour index, whose cells are kAvoidReach
// across. A reach past that, less what a body moves in a step, would miss
// enemies in the next cell but one.
static_assert(kRoleStats[static_cast<int>(Role::kWarrior)].reach < kAvoidReach * 0.75,
              "a warrior's reach must fit inside the neighbour index");

inline double clamp_unit(double value) { return value < -1.0 ? -1.0 : (value > 1.0 ? 1.0 : value); }

inline double dot3(const double a[3], const double b[3]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

inline bool normalize3(double v[3]) {
  const double length = std::sqrt(dot3(v, v));
  if (!(length > 1e-12)) {
    return false;
  }
  v[0] /= length;
  v[1] /= length;
  v[2] /= length;
  return true;
}

inline void cross3(const double a[3], const double b[3], double out[3]) {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
}

// Removes the component of `v` along the unit normal `n`.
inline void flatten(double v[3], const double n[3]) {
  const double along = dot3(v, n);
  v[0] -= n[0] * along;
  v[1] -= n[1] * along;
  v[2] -= n[2] * along;
}

// Unit tangent at `from` pointing along the great circle towards `to`. False
// when the two coincide.
inline bool tangent_towards(const double from[3], const double to[3], double out[3]) {
  out[0] = to[0];
  out[1] = to[1];
  out[2] = to[2];
  flatten(out, from);
  return normalize3(out);
}

// `from` carried `angle` radians along the unit tangent `tangent`.
inline void rotate_along(const double from[3],
                         const double tangent[3],
                         double angle,
                         double out[3]) {
  const double c = std::cos(angle);
  const double s = std::sin(angle);
  out[0] = from[0] * c + tangent[0] * s;
  out[1] = from[1] * c + tangent[1] * s;
  out[2] = from[2] * c + tangent[2] * s;
  normalize3(out);
}

inline double angle_between(const double a[3], const double b[3]) {
  const double dx = a[0] - b[0];
  const double dy = a[1] - b[1];
  const double dz = a[2] - b[2];
  const double chord = std::sqrt(dx * dx + dy * dy + dz * dz);
  return 2.0 * std::asin(clamp_unit(chord * 0.5));
}

// Two unit tangents at the unit vector `n`.
inline void tangent_basis(const double n[3], double e1[3], double e2[3]) {
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
  cross3(n, axis, e1);
  normalize3(e1);
  cross3(n, e1, e2);
}

inline int quantize_axis(double value, int bins) {
  int bin = static_cast<int>(std::floor((value + 1.0) * 0.5 * bins));
  return bin < 0 ? 0 : (bin >= bins ? bins - 1 : bin);
}

inline std::uint32_t pack_cell(int x, int y, int z, int bins) {
  return (static_cast<std::uint32_t>(x) * static_cast<std::uint32_t>(bins) +
          static_cast<std::uint32_t>(y)) *
             static_cast<std::uint32_t>(bins) +
         static_cast<std::uint32_t>(z);
}

}  // namespace detail

// Every follower translation unit reads these unqualified.
using namespace detail;

template <typename Visit>
void FollowerSet::for_each_near(std::int32_t id, double reach, Visit&& visit) const {
  const Follower& self = followers_[static_cast<std::size_t>(id)];
  const double radius = grid_->planet_radius();
  const int bins = index_bins_;
  const int qx = quantize_axis(self.dir[0], bins);
  const int qy = quantize_axis(self.dir[1], bins);
  const int qz = quantize_axis(self.dir[2], bins);
  const double reach_chord_squared = (reach / radius) * (reach / radius);

  for (int x = std::max(0, qx - 1); x <= std::min(bins - 1, qx + 1); ++x) {
    for (int y = std::max(0, qy - 1); y <= std::min(bins - 1, qy + 1); ++y) {
      for (int z = std::max(0, qz - 1); z <= std::min(bins - 1, qz + 1); ++z) {
        const Run& run = runs_[find_run(pack_cell(x, y, z, bins))];
        for (std::int32_t i = run.start; i < run.start + run.count; ++i) {
          const std::int32_t other = cells_[static_cast<std::size_t>(i)].id;
          if (other == id) {
            continue;
          }
          const double* d = followers_[static_cast<std::size_t>(other)].dir;
          double offset[3] = {d[0] - self.dir[0], d[1] - self.dir[1], d[2] - self.dir[2]};
          // Most of the 27 cells' worth is out of reach; turn those away on the
          // chord before doing any more work.
          if (dot3(offset, offset) > reach_chord_squared) {
            continue;
          }
          // Offset in the tangent plane, in world units. The chord and the arc
          // agree to well under a percent at this range.
          flatten(offset, self.dir);
          offset[0] *= radius;
          offset[1] *= radius;
          offset[2] *= radius;
          const double distance = std::sqrt(dot3(offset, offset));
          if (distance <= reach) {
            visit(other, offset, distance);
          }
        }
      }
    }
  }
}

}  // namespace inkulous
