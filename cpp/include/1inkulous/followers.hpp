#pragma once

#include <cstdint>
#include <vector>

#include "1inkulous/nav.hpp"

// Followers: the first units on the planet.
//
// A follower is a point on the sphere — a unit direction plus a height above
// sea level — walking a list of navigation nodes. Everything about them lives
// here in the core; TypeScript spawns them, hands them orders, and reads back a
// packed instance buffer to draw. Nothing is copied across the boundary per
// frame except that one pointer.

namespace inkulous {

// Floats per follower in the render instance buffer:
//   0..2  world position (already scaled by radius + height)
//   3..5  unit heading, tangent to the surface
//   6     tribe index, as a float
//   7     flags bitfield, as a float — see kFlag*
constexpr std::int32_t kFollowerInstanceFloats = 8;

constexpr std::int32_t kFlagSelected = 1 << 0;
constexpr std::int32_t kFlagWalking = 1 << 1;

// World units per second along the surface. On a unit-radius planet a follower
// crosses a typical island in a few seconds and laps the world in a minute or
// two — small enough to read as a person, quick enough to play with.
constexpr double kDefaultFollowerSpeed = 0.06;

// Hard ceiling on the population, so the instance buffer can be sized once on
// the TypeScript side and never reallocated mid-match.
constexpr std::int32_t kMaxFollowers = 1024;

class FollowerSet {
 public:
  // The grid is not owned; it must outlive the set.
  void set_grid(NavGrid* grid) { grid_ = grid; }

  // Places a follower at the walkable node nearest the direction. Returns its
  // id, or -1 if there is no navigation grid, no land nearby, or no room.
  std::int32_t spawn(double x, double y, double z, std::int32_t tribe);

  void clear();

  std::int32_t count() const { return static_cast<std::int32_t>(followers_.size()); }

  void set_selected(std::int32_t id, bool selected);
  void clear_selection();
  std::int32_t selected_count() const;

  // Sends every selected follower to the terrain point under `x, y, z`. Each
  // one paths independently. Returns how many found a route.
  std::int32_t order_move_selected(double x, double y, double z);

  // Advances every walking follower by one fixed step.
  void step(double dt_seconds);

  double speed() const { return speed_; }
  void set_speed(double speed) { speed_ = speed > 0.0 ? speed : kDefaultFollowerSpeed; }

  // Packed instance data, refreshed by `refresh_instances`.
  const float* instances() const { return instances_.data(); }
  void refresh_instances();

 private:
  struct Follower {
    double dir[3] = {0.0, 1.0, 0.0};
    double heading[3] = {1.0, 0.0, 0.0};
    double height = 0.0;
    std::int32_t tribe = 0;
    bool selected = false;

    // Remaining nodes to visit; path_index_ points at the one being walked to.
    std::vector<std::int32_t> path;
    std::size_t path_index = 0;
    // Angle of the segment currently being walked, and the height it began at,
    // so the follower's height can be interpolated across it.
    double segment_angle = 0.0;
    double segment_start_height = 0.0;
    // Last node stood on. Keeps an idle follower glued to ground that is being
    // sculpted underneath it.
    std::int32_t anchor_node = -1;
  };

  void begin_segment(Follower& follower);
  void stop(Follower& follower);
  void step_follower(Follower& follower, double dt_seconds);

  NavGrid* grid_ = nullptr;
  std::vector<Follower> followers_;
  std::vector<float> instances_;
  std::vector<std::int32_t> path_scratch_;
  double speed_ = kDefaultFollowerSpeed;
};

}  // namespace inkulous
