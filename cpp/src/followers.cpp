// The follower set: spawning, removal, selection, the shaman, roles, and the
// packed instance buffer the renderer reads. How followers are ordered and made
// to walk is in follower_orders.cpp and follower_steering.cpp, what they do for
// a hut or a tree in follower_jobs.cpp, and the fight in follower_combat.cpp.

#include "1inkulous/followers.hpp"

#include <algorithm>
#include <cmath>

#include "follower_internal.hpp"

namespace inkulous {

using namespace detail;

std::int32_t FollowerSet::spawn(double x, double y, double z, std::int32_t tribe) {
  if (grid_ == nullptr || !grid_->ready()) {
    return -1;
  }
  if (static_cast<std::int32_t>(followers_.size()) >= kMaxFollowers) {
    return -1;
  }

  const std::int32_t node = grid_->nearest_walkable_node(x, y, z);
  if (node < 0) {
    return -1;
  }

  Follower follower;
  const float* d = grid_->direction(node);
  follower.dir[0] = d[0];
  follower.dir[1] = d[1];
  follower.dir[2] = d[2];
  normalize3(follower.dir);
  follower.node = node;
  follower.height = grid_->height(node);
  follower.tribe = tribe < 0 ? 0 : tribe;

  // Face along the local east-ish direction until the first order arrives, so
  // a freshly spawned group is not all staring the same way by accident of the
  // math. Any tangent will do; this one is stable away from the poles.
  const double east[3] = {-follower.dir[2], 0.0, follower.dir[0]};
  if (!tangent_towards(follower.dir, east, follower.heading)) {
    const double fallback[3] = {1.0, 0.0, 0.0};
    if (!tangent_towards(follower.dir, fallback, follower.heading)) {
      follower.heading[0] = 0.0;
      follower.heading[1] = 0.0;
      follower.heading[2] = 1.0;
    }
  }

  followers_.push_back(std::move(follower));
  // Sized here rather than only in the per-frame rebuild, so `count()` and the
  // instance buffer can never disagree — a reader between a spawn and the next
  // fixed step would otherwise run off the end of the buffer.
  refresh_instances();
  return static_cast<std::int32_t>(followers_.size()) - 1;
}

std::int32_t FollowerSet::spawn_at(const double dir[3], std::int32_t tribe) {
  if (grid_ == nullptr || !grid_->ready()) {
    return -1;
  }
  double at[3] = {dir[0], dir[1], dir[2]};
  if (!normalize3(at)) {
    return -1;
  }
  const std::int32_t id = spawn(at[0], at[1], at[2], tribe);
  if (id < 0) {
    return id;
  }

  // spawn() stands it on the nearest node. Move it onto the exact point when
  // that is ground to stand on: a hut's doorstep is rarely a node, and the
  // node nearest it may well be under the hut.
  Follower& follower = followers_[static_cast<std::size_t>(id)];
  const std::int32_t node = grid_->locate(at, follower.node);
  SurfacePoint ground;
  if (node >= 0 && grid_->footing(at, node, kRouteSupport, ground)) {
    follower.dir[0] = at[0];
    follower.dir[1] = at[1];
    follower.dir[2] = at[2];
    follower.node = node;
    follower.height = ground.height;
    flatten(follower.heading, follower.dir);
    if (!normalize3(follower.heading)) {
      double e2[3];
      tangent_basis(follower.dir, follower.heading, e2);
    }
    refresh_instances();
  }
  return id;
}

bool FollowerSet::set_casting(std::int32_t id, bool casting) {
  if (id < 0 || id >= count()) {
    return false;
  }
  Follower& follower = followers_[static_cast<std::size_t>(id)];
  if (follower.casting != casting) {
    follower.casting = casting;
    refresh_instances();
  }
  return true;
}

void FollowerSet::halt(std::int32_t id) {
  if (id < 0 || id >= count()) {
    return;
  }
  Follower& follower = followers_[static_cast<std::size_t>(id)];
  if (walking(follower)) {
    stop(follower);
    refresh_instances();
  }
}

void FollowerSet::remove(std::int32_t id) {
  if (id < 0 || id >= count()) {
    return;
  }
  followers_.erase(followers_.begin() + id);
  refresh_instances();
}

bool FollowerSet::make_shaman(std::int32_t id) {
  if (id < 0 || id >= count()) {
    return false;
  }
  followers_[static_cast<std::size_t>(id)].shaman = true;
  refresh_instances();
  return true;
}

std::int32_t FollowerSet::shaman(std::int32_t tribe) const {
  for (std::size_t i = 0; i < followers_.size(); ++i) {
    if (followers_[i].shaman && followers_[i].tribe == tribe) {
      return static_cast<std::int32_t>(i);
    }
  }
  return -1;
}

bool FollowerSet::set_role(std::int32_t id, Role role) {
  const auto index = static_cast<std::int32_t>(role);
  if (id < 0 || id >= count() || index < 0 || index >= kRoleCount) {
    return false;
  }
  Follower& follower = followers_[static_cast<std::size_t>(id)];
  if (follower.shaman) {
    return false;
  }
  follower.role = role;
  refresh_instances();
  return true;
}

void FollowerSet::clear() {
  followers_.clear();
  instances_.clear();
  fallen_.fill(false);
}

void FollowerSet::set_selected(std::int32_t id, bool selected) {
  // A fallen tribe's people cannot be picked up again to be given orders.
  if (!takes_orders(id)) {
    return;
  }
  followers_[static_cast<std::size_t>(id)].selected = selected;
}

void FollowerSet::clear_selection() {
  for (Follower& follower : followers_) {
    follower.selected = false;
  }
}

std::int32_t FollowerSet::selected_count() const {
  std::int32_t total = 0;
  for (const Follower& follower : followers_) {
    if (follower.selected) {
      ++total;
    }
  }
  return total;
}

bool FollowerSet::route(std::int32_t id, std::vector<NavPoint>& out) const {
  out.clear();
  if (id < 0 || id >= count()) {
    return false;
  }
  const Follower& follower = followers_[static_cast<std::size_t>(id)];
  if (walking(follower)) {
    out.assign(follower.path.begin() + static_cast<std::ptrdiff_t>(follower.path_index),
               follower.path.end());
  }
  return true;
}

void FollowerSet::refresh_instances() {
  const std::size_t needed = followers_.size() * static_cast<std::size_t>(kFollowerInstanceFloats);
  if (instances_.size() != needed) {
    instances_.resize(needed);
  }

  const double radius = grid_ != nullptr ? grid_->planet_radius() : 1.0;

  for (std::size_t i = 0; i < followers_.size(); ++i) {
    const Follower& follower = followers_[i];
    float* out = &instances_[i * static_cast<std::size_t>(kFollowerInstanceFloats)];

    const double r = radius + follower.height;
    out[0] = static_cast<float>(follower.dir[0] * r);
    out[1] = static_cast<float>(follower.dir[1] * r);
    out[2] = static_cast<float>(follower.dir[2] * r);
    out[3] = static_cast<float>(follower.heading[0]);
    out[4] = static_cast<float>(follower.heading[1]);
    out[5] = static_cast<float>(follower.heading[2]);
    out[6] = static_cast<float>(follower.tribe);

    std::int32_t flags = 0;
    if (follower.selected) flags |= kFlagSelected;
    if (walking(follower)) flags |= kFlagWalking;
    if (follower.shaman) flags |= kFlagShaman;
    if (follower.casting) flags |= kFlagCasting;
    flags |= (static_cast<std::int32_t>(follower.role) << kRoleShift) & kRoleMask;
    out[7] = static_cast<float>(flags);
  }
}

}  // namespace inkulous
