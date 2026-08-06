#include "1inkulous/followers.hpp"

#include <cmath>

namespace inkulous {
namespace {

double clamp_unit(double value) {
  return value < -1.0 ? -1.0 : (value > 1.0 ? 1.0 : value);
}

void normalize3(double v[3]) {
  const double length = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (length > 1e-12) {
    v[0] /= length;
    v[1] /= length;
    v[2] /= length;
  }
}

// Unit tangent at `from` pointing along the great circle towards `to`. Zero
// length when the two coincide, which the caller checks for.
void tangent_towards(const double from[3], const double to[3], double out[3]) {
  const double dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  out[0] = to[0] - from[0] * dot;
  out[1] = to[1] - from[1] * dot;
  out[2] = to[2] - from[2] * dot;
  normalize3(out);
}

// Rotates `from` towards `to` by `angle` along their great circle.
void slerp_towards(double from[3], const double to[3], double angle) {
  double tangent[3];
  tangent_towards(from, to, tangent);

  const double c = std::cos(angle);
  const double s = std::sin(angle);
  double next[3] = {
      from[0] * c + tangent[0] * s,
      from[1] * c + tangent[1] * s,
      from[2] * c + tangent[2] * s,
  };
  normalize3(next);
  from[0] = next[0];
  from[1] = next[1];
  from[2] = next[2];
}

double angle_between(const double a[3], const double b[3]) {
  const double dx = a[0] - b[0];
  const double dy = a[1] - b[1];
  const double dz = a[2] - b[2];
  const double chord = std::sqrt(dx * dx + dy * dy + dz * dz);
  return 2.0 * std::asin(clamp_unit(chord * 0.5));
}

}  // namespace

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
  follower.height = grid_->height(node);
  follower.anchor_node = node;
  follower.tribe = tribe < 0 ? 0 : tribe;

  // Face along the local east-ish direction until the first order arrives, so
  // a freshly spawned group is not all staring the same way by accident of the
  // math. Any tangent will do; this one is stable away from the poles.
  double heading[3] = {-follower.dir[2], 0.0, follower.dir[0]};
  if (std::fabs(heading[0]) + std::fabs(heading[2]) < 1e-9) {
    heading[0] = 1.0;
    heading[1] = 0.0;
    heading[2] = 0.0;
  }
  tangent_towards(follower.dir, heading, follower.heading);
  if (std::fabs(follower.heading[0]) + std::fabs(follower.heading[1]) +
          std::fabs(follower.heading[2]) <
      1e-9) {
    follower.heading[0] = 1.0;
  }

  followers_.push_back(std::move(follower));
  // Sized here rather than only in the per-frame rebuild, so `count()` and the
  // instance buffer can never disagree — a reader between a spawn and the next
  // fixed step would otherwise run off the end of the buffer.
  refresh_instances();
  return static_cast<std::int32_t>(followers_.size()) - 1;
}

void FollowerSet::clear() {
  followers_.clear();
  instances_.clear();
}

void FollowerSet::set_selected(std::int32_t id, bool selected) {
  if (id < 0 || id >= count()) {
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

void FollowerSet::stop(Follower& follower) {
  follower.path.clear();
  follower.path_index = 0;
  follower.segment_angle = 0.0;
}

void FollowerSet::begin_segment(Follower& follower) {
  if (follower.path_index >= follower.path.size()) {
    stop(follower);
    return;
  }

  const float* target = grid_->direction(follower.path[follower.path_index]);
  const double target_dir[3] = {target[0], target[1], target[2]};
  follower.segment_angle = angle_between(follower.dir, target_dir);
  follower.segment_start_height = follower.height;
}

std::int32_t FollowerSet::order_move_selected(double x, double y, double z) {
  if (grid_ == nullptr || !grid_->ready()) {
    return 0;
  }

  // Orders land on terrain, not on water: a click just offshore walks to the
  // nearest shoreline node rather than being thrown away.
  const std::int32_t goal = grid_->nearest_walkable_node(x, y, z);
  if (goal < 0) {
    return 0;
  }

  std::int32_t routed = 0;
  for (Follower& follower : followers_) {
    if (!follower.selected) {
      continue;
    }

    const std::int32_t start =
        grid_->nearest_walkable_node(follower.dir[0], follower.dir[1], follower.dir[2]);
    if (start < 0) {
      continue;
    }

    if (!grid_->find_path(start, goal, path_scratch_)) {
      // No route — an island the follower cannot reach, or ground walled off by
      // slopes. It keeps standing where it is.
      stop(follower);
      continue;
    }

    follower.path.assign(path_scratch_.begin(), path_scratch_.end());
    follower.path_index = 0;
    // The route leaves from `start`, which is where the follower is standing to
    // within half a cell. Re-anchoring keeps the first leg adjacent in the
    // graph, so the walk-time passability check below sees a real edge.
    follower.anchor_node = start;
    if (follower.path.empty()) {
      // Already standing on the goal node.
      stop(follower);
    } else {
      begin_segment(follower);
    }
    ++routed;
  }

  return routed;
}

void FollowerSet::step_follower(Follower& follower, double dt_seconds) {
  if (follower.path_index >= follower.path.size()) {
    // Idle: stay pinned to the ground, which the player may be sculpting.
    if (follower.anchor_node >= 0) {
      follower.height = grid_->height(follower.anchor_node);
    }
    return;
  }

  const double radius = grid_->planet_radius();
  double remaining = speed_ * dt_seconds;

  while (remaining > 0.0 && follower.path_index < follower.path.size()) {
    const std::int32_t node = follower.path[follower.path_index];

    // Terrain can change under a walking follower. Give up the route rather
    // than march into water or up a cliff the player just raised.
    if (!grid_->walkable(node) ||
        (follower.anchor_node >= 0 && !grid_->passable(follower.anchor_node, node))) {
      stop(follower);
      return;
    }

    const float* target = grid_->direction(node);
    const double target_dir[3] = {target[0], target[1], target[2]};
    const double angle = angle_between(follower.dir, target_dir);

    if (angle > 1e-9) {
      tangent_towards(follower.dir, target_dir, follower.heading);
    }

    const double step_angle = remaining / radius;
    if (step_angle >= angle) {
      // Reached the node: snap exactly onto it and start the next segment.
      follower.dir[0] = target_dir[0];
      follower.dir[1] = target_dir[1];
      follower.dir[2] = target_dir[2];
      follower.height = grid_->height(node);
      follower.anchor_node = node;
      remaining -= angle * radius;

      follower.path_index += 1;
      if (follower.path_index >= follower.path.size()) {
        stop(follower);
        return;
      }
      begin_segment(follower);
      continue;
    }

    slerp_towards(follower.dir, target_dir, step_angle);

    // Height rides the straight line between the segment's endpoints, so the
    // follower's feet stay on the terrain it is crossing.
    const double travelled = follower.segment_angle - (angle - step_angle);
    // A fraction along the segment, so the domain is [0, 1] — clamping to
    // [-1, 1] would let a stale segment angle extrapolate the height below the
    // ground the follower set off from.
    const double progress = follower.segment_angle > 1e-12
                                ? travelled / follower.segment_angle
                                : 1.0;
    const double t = progress < 0.0 ? 0.0 : (progress > 1.0 ? 1.0 : progress);
    follower.height = follower.segment_start_height +
                      (grid_->height(node) - follower.segment_start_height) * t;
    remaining = 0.0;
  }
}

void FollowerSet::step(double dt_seconds) {
  if (grid_ == nullptr || !grid_->ready() || !(dt_seconds > 0.0)) {
    return;
  }
  for (Follower& follower : followers_) {
    step_follower(follower, dt_seconds);
  }
}

void FollowerSet::refresh_instances() {
  const std::size_t needed =
      followers_.size() * static_cast<std::size_t>(kFollowerInstanceFloats);
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
    if (follower.path_index < follower.path.size()) flags |= kFlagWalking;
    out[7] = static_cast<float>(flags);
  }
}

}  // namespace inkulous
