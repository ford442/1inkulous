// Per-step walking: steering along a route round other bodies, separating a
// stack, noticing a stall, settling on arrival, and the neighbour index those
// share. FollowerSet::step is the fixed-step entry point and lives here.

#include "1inkulous/followers.hpp"

#include <algorithm>
#include <cmath>

#include "follower_internal.hpp"

namespace inkulous {

bool FollowerSet::try_move(Follower& follower, const double target[3], double support) {
  double p[3] = {target[0], target[1], target[2]};
  if (!normalize3(p)) {
    return false;
  }
  const std::int32_t node = grid_->locate(p, follower.node);
  if (node < 0) {
    return false;
  }

  SurfacePoint ground;
  const bool standable = grid_->footing(p, node, support, ground);
  if (!standable) {
    // Off good ground already — a sculpt stroke or a shove put it there — the
    // follower may still step anywhere it could step between nodes, or it
    // could never walk back.
    const bool escape =
        !follower.grounded && ground.on_mesh && grid_->walkable(node) &&
        (node == follower.node || follower.node < 0 || grid_->passable(follower.node, node));
    if (!escape) {
      return false;
    }
  }

  follower.dir[0] = p[0];
  follower.dir[1] = p[1];
  follower.dir[2] = p[2];
  follower.node = node;
  follower.height = ground.height;
  // Strict ground is loose ground too; only an escape needs asking again.
  SurfacePoint loose;
  follower.grounded = standable || grid_->footing(p, node, kStepSupport, loose);
  return true;
}

bool FollowerSet::segment_taken(std::int32_t id, const double target[3]) const {
  const Follower& self = followers_[static_cast<std::size_t>(id)];
  const double radius = grid_->planet_radius();
  double along[3] = {target[0] - self.dir[0], target[1] - self.dir[1], target[2] - self.dir[2]};
  flatten(along, self.dir);
  along[0] *= radius;
  along[1] *= radius;
  along[2] *= radius;
  const double span = dot3(along, along);
  double travel[3] = {along[0], along[1], along[2]};
  const bool aimed = normalize3(travel);

  bool taken = false;
  const auto occupy = [&](std::int32_t other, const double offset[3], double distance) {
    if (taken) {
      return;
    }
    // Still stacked on us: separation owns that, and refusing the step would
    // freeze a group that has not had a tick to spread.
    if (distance < kStackDistance) {
      return;
    }
    double t = 0.0;
    if (span > 1e-12) {
      t = dot3(offset, along) / span;
      if (t < 0.0) {
        t = 0.0;
      } else if (t > 1.0) {
        t = 1.0;
      }
    }
    const double rel[3] = {
        offset[0] - along[0] * t,
        offset[1] - along[1] * t,
        offset[2] - along[2] * t,
    };
    if (dot3(rel, rel) >= kOccupancyRadius * kOccupancyRadius) {
      return;
    }
    // Sharing our end of the segment, not sitting on the ground ahead.
    if (t < 0.35 && distance < kAvoidReach) {
      return;
    }
    const Follower& them = followers_[static_cast<std::size_t>(other)];
    // Same direction is a queue. The pace limit holds the gap; a repath
    // would only send the file round in circles.
    if (aimed && walking(them) && dot3(travel, them.heading) > kQueueAlike) {
      return;
    }
    taken = true;
  };
  for_each_near(id, kAvoidReach, occupy);
  return taken;
}

void FollowerSet::held(Follower& follower) {
  // Recently re-routed: wait the cooldown out instead of searching again.
  if (follower.repath_cooldown > 0.0) {
    return;
  }
  follower.blocked_steps += 1;
  if (follower.blocked_steps < kOccupancyBlocks) {
    return;
  }
  follower.blocked_steps = 0;

  const double to_goal = angle_between(follower.dir, follower.goal.dir) * grid_->planet_radius();
  if (to_goal <= follower.settle_radius) {
    stop(follower);
    return;
  }
  // One search from the anchor, then give up if the way is still shut.
  // Either way the rest of the set keeps stepping.
  if (follower.occupancy_repathed || follower.repaths >= kMaxRepaths || !repath(follower)) {
    stop(follower);
    return;
  }
  follower.occupancy_repathed = true;
}

void FollowerSet::blocked(Follower& follower) {
  // The ground ahead changed — or a shove put the follower somewhere its leg
  // no longer runs clear from. Look for another way, at most once a second;
  // in between it waits. No way at all and it gives up where it stands.
  if (follower.repath_cooldown > 0.0) {
    return;
  }
  if (follower.repaths >= kMaxRepaths || !repath(follower)) {
    stop(follower);
  }
}

void FollowerSet::steer(std::int32_t id, double dt_seconds) {
  Follower& follower = followers_[static_cast<std::size_t>(id)];
  const double radius = grid_->planet_radius();
  double budget = speed_ * role_stats(follower.role).speed * dt_seconds / radius;
  follower.crowded = false;
  follower.corner_wait -= dt_seconds;
  const double was[3] = {follower.dir[0], follower.dir[1], follower.dir[2]};

  while (budget > 1e-12 && walking(follower)) {
    const NavPoint waypoint = follower.path[follower.path_index];
    const bool last_leg = follower.path_index + 1 == follower.path.size();
    const double angle = angle_between(follower.dir, waypoint.dir);

    if (angle <= budget) {
      if (!last_leg) {
        // Close enough to round this vertex. Stepping onto it would stack
        // the file; the offset the spread has already earned stays put.
        follower.anchor_node = waypoint.node;
        follower.path_index += 1;
        follower.corner_wait = 0.0;
        follower.repaths = 0;
        follower.blocked_steps = 0;
        follower.best_waypoint_angle =
            angle_between(follower.dir, follower.path[follower.path_index].dir);
        follower.stall_seconds = 0.0;
        continue;
      }
      if (segment_taken(id, waypoint.dir)) {
        held(follower);
        break;
      }
      if (!try_move(follower, waypoint.dir, kStepSupport)) {
        blocked(follower);
        break;
      }
      follower.anchor_node = follower.node;
      stop(follower);
      break;
    }

    if (!last_leg && follower.corner_wait <= 0.0 && angle * radius <= kCornerReach) {
      // Not from here, perhaps from a step or two on: a crowd round a corner
      // jostles its members to the outside of it in turn.
      follower.corner_wait = kCornerRetry;
      const NavPoint& after = follower.path[follower.path_index + 1];
      if (grid_->clear_line(follower.dir, follower.node, after.dir)) {
        follower.path_index += 1;
        follower.corner_wait = 0.0;
        follower.best_waypoint_angle = angle_between(follower.dir, after.dir);
        follower.stall_seconds = 0.0;
        continue;
      }
    }

    double desired[3];
    if (!tangent_towards(follower.dir, waypoint.dir, desired)) {
      break;
    }

    // Local avoidance: anyone ahead and close to the line gets stepped round,
    // to whichever side they are not on. Someone walking the same way is not an
    // obstacle — they are going to be gone by the time this one gets there —
    // so instead of swerving round them, this one falls in behind.
    double side[3];
    cross3(follower.dir, desired, side);
    const double to_waypoint = angle * radius;
    double swerve = 0.0;
    double pace = 1.0;
    const auto avoid = [&](std::int32_t other, const double offset[3], double distance) {
      if (distance < kCrowdedReach) {
        follower.crowded = true;
      }
      const double ahead = dot3(offset, desired);
      // Behind, or past the waypoint: someone standing on the spot this one
      // is heading for is not in the way of getting there, and stepping round
      // them would only circle it.
      if (ahead <= 0.0 || ahead > to_waypoint) {
        return;
      }
      const double lateral = dot3(offset, side);
      if (std::fabs(lateral) > kFollowerSpacing) {
        return;
      }
      const Follower& them = followers_[static_cast<std::size_t>(other)];
      double weight = 1.0 - distance / kAvoidReach;
      if (walking(them)) {
        const double alike = dot3(follower.heading, them.heading);
        weight *= 0.5 * (1.0 - alike);
        // Only queue behind someone who sees this one behind them too. Two
        // walkers converging on a gap can each be "ahead" of the other by
        // their own lights, and if both held back neither would ever go.
        if (alike > kQueueAlike && dot3(offset, them.heading) > 0.0) {
          // Close the gap to one spacing and hold it there.
          const double gap = (ahead - kFollowerSpacing) / (kFollowerSpacing * 0.5);
          pace = std::min(pace, gap < 0.0 ? 0.0 : gap);
        }
      }
      if (weight <= 0.0) {
        return;
      }
      // Dead ahead, the lower id goes left: both sides of a head-on meeting
      // pick the same rule and so pass each other.
      const double away = lateral > 0.0 ? -1.0 : (lateral < 0.0 ? 1.0 : (id < other ? 1.0 : -1.0));
      swerve += away * weight * kAvoidGain;
    };
    for_each_near(id, kAvoidReach, avoid);
    // Spread the file around this waypoint. The bias grows as the vertex
    // gets close, so open ground stays a straight leg and a corner does not
    // collect everyone on the node.
    if (!last_leg && follower.lane != 0.0) {
      const double proximity = kFollowerSpacing / std::max(to_waypoint, kFollowerSpacing);
      const double lanes = std::max(-3.0, std::min(3.0, follower.lane));
      swerve += lanes * proximity * kLaneGain;
    }
    swerve = std::max(-kMaxSwerve, std::min(kMaxSwerve, swerve));
    budget *= pace;
    if (!(budget > 1e-12)) {
      break;
    }

    // 1 moved, 0 the ground is free but a body owns it, -1 the ground refused.
    int ground = -1;
    const auto attempt = [&](const double heading[3], double support, double scale) {
      double target[3];
      rotate_along(follower.dir, heading, budget * scale, target);
      if (segment_taken(id, target)) {
        ground = std::max(ground, 0);
        return false;
      }
      if (!try_move(follower, target, support)) {
        return false;
      }
      ground = 1;
      return true;
    };

    bool moved = false;
    if (swerve != 0.0) {
      double heading[3] = {
          desired[0] + side[0] * swerve,
          desired[1] + side[1] * swerve,
          desired[2] + side[2] * swerve,
      };
      normalize3(heading);
      moved = attempt(heading, kRouteSupport, 1.0);
      if (!moved && ground == 0) {
        moved = attempt(heading, kRouteSupport, 0.5) || attempt(heading, kRouteSupport, 0.25);
      }
    }
    if (!moved) {
      moved = attempt(desired, kStepSupport, 1.0);
      if (!moved && ground == 0) {
        moved = attempt(desired, kStepSupport, 0.5) || attempt(desired, kStepSupport, 0.25);
      }
    }
    // Shoved against a shore or the foot of a slope, the straight way on can
    // clip bad ground the leg itself steered clear of. Slide along it, nearest
    // angle first, before deciding the way is shut.
    for (int turn = 0; !moved && turn < kSlideTurns; ++turn) {
      const double angle_off = kSlideAngles[turn / 2] * (turn % 2 == 0 ? 1.0 : -1.0);
      double slide[3] = {
          desired[0] * std::cos(angle_off) + side[0] * std::sin(angle_off),
          desired[1] * std::cos(angle_off) + side[1] * std::sin(angle_off),
          desired[2] * std::cos(angle_off) + side[2] * std::sin(angle_off),
      };
      normalize3(slide);
      moved = attempt(slide, kRouteSupport, 1.0);
    }
    if (!moved) {
      if (ground == 0) {
        held(follower);
      } else {
        blocked(follower);
      }
      break;
    }
    follower.blocked_steps = 0;
    follower.anchor_node = follower.node;
    budget = 0.0;
  }

  // Face the way it actually went, eased so a swerve does not snap the pawn
  // round in one step.
  double moved[3] = {follower.dir[0] - was[0], follower.dir[1] - was[1], follower.dir[2] - was[2]};
  flatten(moved, follower.dir);
  if (normalize3(moved)) {
    follower.heading[0] = follower.heading[0] * 0.5 + moved[0] * 0.5;
    follower.heading[1] = follower.heading[1] * 0.5 + moved[1] * 0.5;
    follower.heading[2] = follower.heading[2] * 0.5 + moved[2] * 0.5;
  }
}

void FollowerSet::watch_progress(Follower& follower, double dt_seconds) {
  if (!walking(follower)) {
    return;
  }
  follower.repath_cooldown -= dt_seconds;

  // Progress is getting closer to the current waypoint, so a detour that
  // leads away from the goal for a while still counts.
  const double angle = angle_between(follower.dir, follower.path[follower.path_index].dir);
  const double step = speed_ * dt_seconds / grid_->planet_radius();
  if (angle < follower.best_waypoint_angle - step * kProgressFraction) {
    follower.best_waypoint_angle = angle;
    follower.stall_seconds = 0.0;
    follower.jammed_seconds = 0.0;
    return;
  }

  follower.stall_seconds += dt_seconds;
  if (follower.stall_seconds < kStallSeconds) {
    return;
  }
  follower.stall_seconds = 0.0;

  // Hemmed in at the edge of its own group: that is arriving.
  const double to_goal = angle_between(follower.dir, follower.goal.dir) * grid_->planet_radius();
  if (to_goal <= follower.settle_radius) {
    stop(follower);
    return;
  }
  // Queued behind others at a narrow place: the way is fine, it is just busy.
  // Wait for it, up to a point — two crowds meeting head-on in a gully can
  // wedge each other for good.
  if (follower.crowded && follower.jammed_seconds < kJamPatience) {
    follower.jammed_seconds += kStallSeconds;
    return;
  }
  follower.jammed_seconds = 0.0;
  follower.stalls += 1;
  if (follower.stalls > kMaxStalls || follower.repaths >= kMaxRepaths || !repath(follower)) {
    stop(follower);
  }
}

void FollowerSet::separate() {
  const double radius = grid_->planet_radius();
  for (Follower& follower : followers_) {
    follower.push[0] = 0.0;
    follower.push[1] = 0.0;
    follower.push[2] = 0.0;
  }

  // The index steering built at the top of the step still serves: its cells
  // are wider than the spacing by more than anyone has moved since.
  const std::int32_t total = count();
  for (std::int32_t id = 0; id < total; ++id) {
    Follower& self = followers_[static_cast<std::size_t>(id)];
    const auto part = [&](std::int32_t other, const double offset[3], double distance) {
      // Each pair once.
      if (other <= id) {
        return;
      }
      Follower& them = followers_[static_cast<std::size_t>(other)];
      const double overlap = kFollowerSpacing - distance;

      double away[3];
      if (distance > 1e-9) {
        away[0] = -offset[0] / distance;
        away[1] = -offset[1] / distance;
        away[2] = -offset[2] / distance;
      } else {
        double e1[3];
        double e2[3];
        tangent_basis(self.dir, e1, e2);
        const double turn = kGoldenAngle * static_cast<double>(id + other * 31);
        away[0] = e1[0] * std::cos(turn) + e2[0] * std::sin(turn);
        away[1] = e1[1] * std::cos(turn) + e2[1] * std::sin(turn);
        away[2] = e1[2] * std::cos(turn) + e2[2] * std::sin(turn);
      }

      double mine = 0.5;
      if (walking(self) != walking(them)) {
        mine = walking(self) ? kWalkerShare : 1.0 - kWalkerShare;
      }
      const double theirs = 1.0 - mine;
      for (int axis = 0; axis < 3; ++axis) {
        self.push[axis] += away[axis] * overlap * mine;
        them.push[axis] -= away[axis] * overlap * theirs;
      }
    };
    for_each_near(id, kFollowerSpacing, part);
  }

  for (Follower& follower : followers_) {
    flatten(follower.push, follower.dir);
    const double length = std::sqrt(dot3(follower.push, follower.push));
    if (!(length > 1e-12)) {
      continue;
    }
    double step = length > kMaxPush ? kMaxPush : length;
    // An arrival may yield to the crowd, but only within the point it was
    // given: past this it would read as having left the weld. The partner
    // keeps the rest of the overlap, which is what opens the gap when this
    // one is the body standing on the clicked cell.
    if (!walking(follower) && follower.goal.node >= 0) {
      const double from_goal = angle_between(follower.dir, follower.goal.dir) * radius;
      if (from_goal < kGoalHold) {
        const double slack = kGoalHold - from_goal;
        if (step > slack) {
          step = slack;
        }
      }
    }
    const double scale = (step / length) / radius;
    const double target[3] = {
        follower.dir[0] + follower.push[0] * scale,
        follower.dir[1] + follower.push[1] * scale,
        follower.dir[2] + follower.push[2] * scale,
    };
    // A shove that would put someone in the water or up a cliff just does not
    // happen; the overlap waits for another direction to open.
    try_move(follower, target, kRouteSupport);
  }
}

void FollowerSet::settle(Follower& follower) {
  // Ground may have been sculpted under anyone, walking or not.
  const std::int32_t node = grid_->locate(follower.dir, follower.node);
  if (node >= 0) {
    SurfacePoint ground;
    follower.grounded = grid_->footing(follower.dir, node, kStepSupport, ground);
    follower.node = node;
    follower.height = ground.height;
  }

  flatten(follower.heading, follower.dir);
  if (!normalize3(follower.heading)) {
    double e2[3];
    tangent_basis(follower.dir, follower.heading, e2);
  }
}

void FollowerSet::build_index(double reach) {
  // Cells at least `reach` across, so everyone within reach of a follower is in
  // its own cell or one of the 26 around it.
  const double cell = reach / grid_->planet_radius();
  int bins = static_cast<int>(std::floor(2.0 / cell));
  bins = bins < 1 ? 1 : (bins > 1024 ? 1024 : bins);
  index_bins_ = bins;

  cells_.resize(followers_.size());
  for (std::size_t i = 0; i < followers_.size(); ++i) {
    const double* d = followers_[i].dir;
    cells_[i].key = pack_cell(quantize_axis(d[0], bins), quantize_axis(d[1], bins),
                              quantize_axis(d[2], bins), bins);
    cells_[i].id = static_cast<std::int32_t>(i);
  }
  std::sort(cells_.begin(), cells_.end(), [](const Cell& a, const Cell& b) {
    return a.key < b.key || (a.key == b.key && a.id < b.id);
  });

  // Each occupied cell's run of the sorted list, in a small open-addressed
  // table, so a query's 27 cell lookups are a probe each rather than a search.
  std::size_t capacity = 16;
  while (capacity < cells_.size() * 2) {
    capacity <<= 1;
  }
  runs_.assign(capacity, Run{});
  for (std::size_t i = 0; i < cells_.size();) {
    std::size_t end = i + 1;
    while (end < cells_.size() && cells_[end].key == cells_[i].key) {
      ++end;
    }
    Run& run = runs_[find_run(cells_[i].key)];
    run.key = cells_[i].key;
    run.start = static_cast<std::int32_t>(i);
    run.count = static_cast<std::int32_t>(end - i);
    i = end;
  }
}

std::size_t FollowerSet::find_run(std::uint32_t key) const {
  const std::size_t mask = runs_.size() - 1;
  std::size_t slot = (static_cast<std::size_t>(key) * 0x9E3779B1u) & mask;
  while (runs_[slot].count != 0 && runs_[slot].key != key) {
    slot = (slot + 1) & mask;
  }
  return slot;
}

void FollowerSet::step(double dt_seconds) {
  if (grid_ == nullptr || !grid_->ready() || !(dt_seconds > 0.0) || followers_.empty()) {
    return;
  }

  build_index(kAvoidReach);
  const std::int32_t total = count();
  for (std::int32_t id = 0; id < total; ++id) {
    Follower& follower = followers_[static_cast<std::size_t>(id)];
    if (!walking(follower)) {
      continue;
    }
    steer(id, dt_seconds);
    watch_progress(follower, dt_seconds);
  }

  separate();

  for (Follower& follower : followers_) {
    settle(follower);
  }

  fight(dt_seconds);
}

}  // namespace inkulous
