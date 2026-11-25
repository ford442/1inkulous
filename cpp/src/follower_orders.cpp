// Giving followers somewhere to go: routing a group order into formation slots,
// following a route, re-routing, and the terrain effects that move or re-plan
// walkers (set down, shove, strand, reroute_across). The per-step walking
// itself is in follower_steering.cpp.

#include "1inkulous/followers.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

#include "follower_internal.hpp"

namespace inkulous {

void FollowerSet::set_down(Follower& follower, std::int32_t node) {
  const float* d = grid_->direction(node);
  follower.dir[0] = d[0];
  follower.dir[1] = d[1];
  follower.dir[2] = d[2];
  normalize3(follower.dir);
  follower.node = node;
  follower.height = grid_->height(node);
  follower.grounded = true;
  flatten(follower.heading, follower.dir);
  if (!normalize3(follower.heading)) {
    double e2[3];
    tangent_basis(follower.dir, follower.heading, e2);
  }
}

void FollowerSet::reroute(Follower& follower) {
  // A goal on ground that has gone bad moves to the nearest good node; either
  // way the route is planned again over the ground as it is now.
  NavPoint goal = follower.goal;
  if (goal.node < 0 || !grid_->walkable(goal.node)) {
    goal.node = grid_->nearest_walkable_node(goal.dir[0], goal.dir[1], goal.dir[2]);
    if (goal.node < 0) {
      stop(follower);
      return;
    }
    const float* g = grid_->direction(goal.node);
    goal.dir[0] = g[0];
    goal.dir[1] = g[1];
    goal.dir[2] = g[2];
  }
  if (!route_to(follower, goal)) {
    stop(follower);
  }
}

void FollowerSet::step_off_blocked() {
  if (grid_ == nullptr || !grid_->ready()) {
    return;
  }
  bool moved = false;
  for (Follower& follower : followers_) {
    const std::int32_t node = grid_->locate(follower.dir, follower.node);
    if (node < 0) {
      continue;
    }
    SurfacePoint ground;
    grid_->sample(follower.dir, node, ground);
    bool inside = false;
    for (int corner = 0; corner < 3; ++corner) {
      // The loose limit, the one each step is held to: a body this far onto
      // the pad could not take another step.
      if (ground.nodes[corner] >= 0 && ground.weights[corner] > kStepSupport &&
          grid_->blocked(ground.nodes[corner])) {
        inside = true;
      }
    }

    if (inside) {
      const std::int32_t free =
          grid_->nearest_walkable_node(follower.dir[0], follower.dir[1], follower.dir[2]);
      if (free < 0) {
        continue;
      }
      set_down(follower, free);
      moved = true;
    }

    if (walking(follower)) {
      // Round the footprint rather than through it.
      reroute(follower);
    }
  }
  if (moved) {
    refresh_instances();
  }
}

namespace {

// Angle from unit `c` to the nearest point of the great-circle arc from unit
// `a` to unit `b`.
double arc_distance(const double c[3], const double a[3], const double b[3]) {
  double n[3];
  cross3(a, b, n);
  if (normalize3(n)) {
    // The foot of the perpendicular from c, if it falls between a and b.
    double p[3] = {c[0], c[1], c[2]};
    flatten(p, n);
    if (normalize3(p)) {
      double ap[3];
      double pb[3];
      cross3(a, p, ap);
      cross3(p, b, pb);
      if (dot3(ap, n) >= 0.0 && dot3(pb, n) >= 0.0) {
        return angle_between(c, p);
      }
    }
  }
  return std::min(angle_between(c, a), angle_between(c, b));
}

}  // namespace

std::int32_t FollowerSet::shove(const double centre_in[3], double angular_radius, double beyond) {
  double centre[3] = {centre_in[0], centre_in[1], centre_in[2]};
  if (grid_ == nullptr || !grid_->ready() || !(angular_radius > 0.0) || !normalize3(centre)) {
    return 0;
  }
  const double out_to = angular_radius + std::max(beyond, 0.0);
  std::int32_t moved = 0;
  for (Follower& follower : followers_) {
    const double from_centre = angle_between(centre, follower.dir);
    if (from_centre >= angular_radius) {
      continue;
    }
    // Straight away from the centre; someone standing on it goes the way
    // they face.
    double away[3];
    if (!tangent_towards(centre, follower.dir, away)) {
      away[0] = follower.heading[0];
      away[1] = follower.heading[1];
      away[2] = follower.heading[2];
      flatten(away, centre);
      if (!normalize3(away)) {
        double e2[3];
        tangent_basis(centre, away, e2);
      }
    }
    double landing[3];
    rotate_along(centre, away, out_to, landing);

    const std::int32_t node = grid_->locate(landing, follower.node);
    SurfacePoint ground;
    if (node >= 0 && grid_->footing(landing, node, kRouteSupport, ground)) {
      follower.dir[0] = landing[0];
      follower.dir[1] = landing[1];
      follower.dir[2] = landing[2];
      follower.node = node;
      follower.height = ground.height;
      follower.grounded = true;
    } else {
      const std::int32_t free = grid_->nearest_walkable_node(landing[0], landing[1], landing[2]);
      if (free < 0) {
        continue;
      }
      set_down(follower, free);
    }
    // Facing the way they were thrown: away from the centre.
    double back[3];
    if (tangent_towards(follower.dir, centre, back)) {
      follower.heading[0] = -back[0];
      follower.heading[1] = -back[1];
      follower.heading[2] = -back[2];
    }
    if (walking(follower)) {
      reroute(follower);
    }
    ++moved;
  }
  if (moved > 0) {
    refresh_instances();
  }
  return moved;
}

std::int32_t FollowerSet::strand(const double centre_in[3], double angular_radius) {
  double centre[3] = {centre_in[0], centre_in[1], centre_in[2]};
  if (grid_ == nullptr || !grid_->ready() || !(angular_radius > 0.0) || !normalize3(centre)) {
    return 0;
  }
  // A cell's width past the rim: the falloff can leave a wet node there.
  const double reach = angular_radius + grid_->max_link_angle();
  std::int32_t moved = 0;
  for (Follower& follower : followers_) {
    if (angle_between(centre, follower.dir) > reach) {
      continue;
    }
    const std::int32_t node = grid_->locate(follower.dir, follower.node);
    SurfacePoint ground;
    if (node >= 0 && grid_->footing(follower.dir, node, kStepSupport, ground)) {
      continue;
    }
    const std::int32_t dry =
        grid_->nearest_walkable_node(follower.dir[0], follower.dir[1], follower.dir[2]);
    if (dry < 0) {
      continue;
    }
    set_down(follower, dry);
    stop(follower);
    ++moved;
  }
  if (moved > 0) {
    refresh_instances();
  }
  return moved;
}

void FollowerSet::reroute_across(const double centre_in[3], double angular_radius) {
  double centre[3] = {centre_in[0], centre_in[1], centre_in[2]};
  if (grid_ == nullptr || !grid_->ready() || !(angular_radius > 0.0) || !normalize3(centre)) {
    return;
  }
  bool changed = false;
  for (Follower& follower : followers_) {
    if (!walking(follower)) {
      continue;
    }
    bool crosses = false;
    const double* from = follower.dir;
    for (std::size_t i = follower.path_index; i < follower.path.size() && !crosses; ++i) {
      const double* to = follower.path[i].dir;
      crosses = arc_distance(centre, from, to) < angular_radius;
      from = to;
    }
    if (crosses) {
      reroute(follower);
      changed = true;
    }
  }
  if (changed) {
    refresh_instances();
  }
}

void FollowerSet::stop(Follower& follower) {
  follower.path.clear();
  follower.path_index = 0;
  follower.stall_seconds = 0.0;
}

std::int32_t FollowerSet::start_node(const Follower& follower) const {
  // A follower shoved onto water still has to leave from land.
  if (follower.node >= 0 && grid_->walkable(follower.node)) {
    return follower.node;
  }
  return grid_->nearest_walkable_node(follower.dir[0], follower.dir[1], follower.dir[2]);
}

void FollowerSet::follow(Follower& follower,
                         std::int32_t start,
                         const std::vector<std::int32_t>& nodes,
                         const NavPoint& goal) {
  NavPoint from;
  from.dir[0] = follower.dir[0];
  from.dir[1] = follower.dir[1];
  from.dir[2] = follower.dir[2];
  from.node = start;
  grid_->smooth_path(from, nodes, goal, follower.path);

  follower.path_index = 0;
  follower.corner_wait = 0.0;
  follower.goal = goal;
  follower.anchor_node = start;
  follower.blocked_steps = 0;
  follower.best_waypoint_angle =
      follower.path.empty() ? 0.0 : angle_between(follower.dir, follower.path.front().dir);
  follower.stall_seconds = 0.0;
  follower.jammed_seconds = 0.0;
}

bool FollowerSet::route_to(Follower& follower, const NavPoint& goal) {
  const std::int32_t start = start_node(follower);
  if (start < 0 || goal.node < 0 || !grid_->find_path(start, goal.node, path_scratch_)) {
    return false;
  }
  follow(follower, start, path_scratch_, goal);
  return true;
}

bool FollowerSet::repath(Follower& follower) {
  follower.repaths += 1;
  follower.repath_cooldown = kRepathCooldown;
  const NavPoint goal = follower.goal;
  // Leave from the anchor — the node this leg set out from — while the
  // follower is still on it. Once it has walked on, the node under it is the
  // one that can actually start a route.
  std::int32_t from = follower.anchor_node;
  if (from < 0 || !grid_->walkable(from)) {
    from = start_node(follower);
  }
  const std::int32_t standing = start_node(follower);
  if (standing >= 0 && standing != from && from >= 0) {
    const float* d = grid_->direction(from);
    const double at[3] = {d[0], d[1], d[2]};
    if (angle_between(follower.dir, at) > grid_->max_link_angle() * 2.0) {
      from = standing;
    }
  }
  if (from < 0 || goal.node < 0 || !grid_->find_path(from, goal.node, path_scratch_)) {
    return false;
  }
  follow(follower, from, path_scratch_, goal);
  return true;
}

void FollowerSet::plan_slots(const double centre[3], std::int32_t goal_node, std::int32_t wanted) {
  slots_.clear();
  if (wanted <= 0) {
    return;
  }

  const double radius = grid_->planet_radius();
  const double spacing = kSlotSpacing / radius;

  // Rings a hex packing needs for the group, then twice that to look in, so a
  // shoreline or a hill that eats half the spots still leaves enough.
  std::int32_t rings = 0;
  while (1 + 3 * rings * (rings + 1) < wanted) {
    ++rings;
  }
  const std::int32_t max_ring = rings * 2 + 2;
  const double reach = (max_ring + 1) * spacing + 2.0 * grid_->max_link_angle();

  // The ground the goal connects to, within reach of it. A spot is only worth
  // offering if it is here: otherwise it may be across water or up a cliff,
  // and whoever got it would never arrive.
  const std::int32_t node_count = grid_->node_count();
  if (static_cast<std::int32_t>(flood_stamp_.size()) != node_count) {
    flood_stamp_.assign(static_cast<std::size_t>(node_count), 0);
    flood_parent_.assign(static_cast<std::size_t>(node_count), -1);
    flood_generation_ = 0;
  }
  ++flood_generation_;
  if (flood_generation_ == 0) {
    std::fill(flood_stamp_.begin(), flood_stamp_.end(), 0);
    flood_generation_ = 1;
  }
  flood_queue_.clear();
  flood_queue_.push_back(goal_node);
  flood_stamp_[static_cast<std::size_t>(goal_node)] = flood_generation_;
  flood_parent_[static_cast<std::size_t>(goal_node)] = -1;
  for (std::size_t head = 0; head < flood_queue_.size(); ++head) {
    const std::int32_t node = flood_queue_[head];
    const std::int32_t* links = grid_->neighbor_offsets();
    for (std::int32_t link = links[node]; link < links[node + 1]; ++link) {
      const std::int32_t next = grid_->neighbors()[link];
      if (flood_stamp_[static_cast<std::size_t>(next)] == flood_generation_ ||
          !grid_->steppable(node, link)) {
        continue;
      }
      const float* d = grid_->direction(next);
      const double dir[3] = {d[0], d[1], d[2]};
      if (angle_between(dir, centre) > reach) {
        continue;
      }
      flood_stamp_[static_cast<std::size_t>(next)] = flood_generation_;
      flood_parent_[static_cast<std::size_t>(next)] = node;
      flood_queue_.push_back(next);
    }
  }

  double e1[3];
  double e2[3];
  tangent_basis(centre, e1, e2);

  SurfacePoint ground;
  const auto offer = [&](double u, double v) {
    double p[3] = {
        centre[0] + e1[0] * u + e2[0] * v,
        centre[1] + e1[1] * u + e2[1] * v,
        centre[2] + e1[2] * u + e2[2] * v,
    };
    if (!normalize3(p)) {
      return;
    }
    const std::int32_t node = grid_->locate(p, goal_node);
    if (node < 0 || flood_stamp_[static_cast<std::size_t>(node)] != flood_generation_) {
      return;
    }
    if (!grid_->footing(p, node, kRouteSupport, ground)) {
      return;
    }
    NavPoint slot;
    slot.dir[0] = p[0];
    slot.dir[1] = p[1];
    slot.dir[2] = p[2];
    slot.node = node;
    slots_.push_back(slot);
  };

  // Hex rings, centre outwards. Ring r has 6r spots, walked side by side from
  // the corner at angle zero.
  constexpr double kPi = std::numbers::pi;
  for (std::int32_t ring = 0; ring <= max_ring; ++ring) {
    if (ring == 0) {
      offer(0.0, 0.0);
    }
    for (int side = 0; side < 6 && ring > 0; ++side) {
      const double a0 = side * kPi / 3.0;
      const double a1 = (side + 1) * kPi / 3.0;
      for (std::int32_t k = 0; k < ring; ++k) {
        const double t = static_cast<double>(k) / ring;
        const double u = (std::cos(a0) * (1.0 - t) + std::cos(a1) * t) * ring * spacing;
        const double v = (std::sin(a0) * (1.0 - t) + std::sin(a1) * t) * ring * spacing;
        offer(u, v);
        if (static_cast<std::int32_t>(slots_.size()) >= wanted) {
          return;
        }
      }
    }
    if (static_cast<std::int32_t>(slots_.size()) >= wanted) {
      return;
    }
  }
}

void FollowerSet::claim_distinct_nodes(const double centre[3]) {
  const std::int32_t node_count = grid_->node_count();
  if (node_count <= 0 || slots_.empty() || flood_queue_.empty()) {
    return;
  }
  node_claim_.assign(static_cast<std::size_t>(node_count), -1);

  // The slot on the clicked point keeps that weld. Everyone else who landed
  // in a cell already claimed slides onto a free neighbour when one is close
  // enough that the group does not scatter.
  claim_order_.resize(slots_.size());
  std::int32_t pinned = -1;
  for (std::size_t i = 0; i < slots_.size(); ++i) {
    claim_order_[i] = static_cast<std::int32_t>(i);
    if (pinned < 0 && angle_between(slots_[i].dir, centre) < 1e-6) {
      pinned = static_cast<std::int32_t>(i);
    }
  }
  if (pinned > 0) {
    std::swap(claim_order_[0], claim_order_[static_cast<std::size_t>(pinned)]);
  }

  const double radius = grid_->planet_radius();
  const double reach = std::max(kClaimReach, grid_->max_link_angle() * radius * 2.0);

  for (const std::int32_t index : claim_order_) {
    NavPoint& slot = slots_[static_cast<std::size_t>(index)];
    if (slot.node >= 0 && slot.node < node_count &&
        node_claim_[static_cast<std::size_t>(slot.node)] < 0) {
      node_claim_[static_cast<std::size_t>(slot.node)] = index;
      continue;
    }

    std::int32_t best = -1;
    double best_distance = reach;
    for (const std::int32_t node : flood_queue_) {
      if (node < 0 || node >= node_count || node_claim_[static_cast<std::size_t>(node)] >= 0) {
        continue;
      }
      const float* d = grid_->direction(node);
      const double dir[3] = {d[0], d[1], d[2]};
      const double distance = angle_between(dir, slot.dir) * radius;
      if (distance >= best_distance) {
        continue;
      }
      bool clear = true;
      for (std::size_t other = 0; other < slots_.size(); ++other) {
        if (static_cast<std::int32_t>(other) == index) {
          continue;
        }
        if (angle_between(dir, slots_[other].dir) * radius < kSlotSpacing) {
          clear = false;
          break;
        }
      }
      if (!clear) {
        continue;
      }
      best = node;
      best_distance = distance;
    }
    if (best < 0) {
      // Nowhere local is free. Keep the packed point; separation holds the gap.
      continue;
    }
    const float* d = grid_->direction(best);
    slot.dir[0] = d[0];
    slot.dir[1] = d[1];
    slot.dir[2] = d[2];
    slot.node = best;
    node_claim_[static_cast<std::size_t>(best)] = index;
  }
}

std::int32_t FollowerSet::order_move_selected(double x, double y, double z) {
  std::vector<std::int32_t> ids;
  for (std::int32_t id = 0; id < count(); ++id) {
    if (followers_[static_cast<std::size_t>(id)].selected) {
      ids.push_back(id);
    }
  }
  return order_move(ids, x, y, z);
}

std::int32_t FollowerSet::order_move(const std::vector<std::int32_t>& ids,
                                     double x,
                                     double y,
                                     double z) {
  if (grid_ == nullptr || !grid_->ready()) {
    return 0;
  }

  // Orders land on terrain, not on water: a click just offshore walks to the
  // nearest shoreline node rather than being thrown away.
  const std::int32_t goal = grid_->nearest_walkable_node(x, y, z);
  if (goal < 0) {
    return 0;
  }

  members_.clear();
  start_scratch_.clear();
  for (const std::int32_t id : ids) {
    if (!takes_orders(id)) {
      continue;
    }
    Follower& follower = followers_[static_cast<std::size_t>(id)];
    follower.hut = -1;
    follower.tree = -1;
    ++follower.orders;
    const std::int32_t start = start_node(follower);
    members_.push_back(Member{id, start, 0.0});
    start_scratch_.push_back(start);
  }
  if (members_.empty()) {
    return 0;
  }

  // One search out from the goal finds everybody's way in.
  grid_->search_toward(goal, start_scratch_);
  for (Member& member : members_) {
    member.distance = grid_->distance_toward(member.start);
  }
  // Soonest to arrive first, by the way they will actually walk.
  std::sort(members_.begin(), members_.end(), [](const Member& a, const Member& b) {
    return a.distance < b.distance || (a.distance == b.distance && a.id < b.id);
  });

  // The group gathers round the exact point clicked when it is ground to stand
  // on in the goal's own cell, and round the goal node otherwise.
  double centre[3] = {x, y, z};
  normalize3(centre);
  SurfacePoint ground;
  if (grid_->locate(centre, goal) != goal || !grid_->footing(centre, goal, kRouteSupport, ground)) {
    const float* d = grid_->direction(goal);
    centre[0] = d[0];
    centre[1] = d[1];
    centre[2] = d[2];
    normalize3(centre);
  }

  const auto group = static_cast<std::int32_t>(members_.size());
  plan_slots(centre, goal, group);
  order_slots_by_approach(centre, goal);
  claim_distinct_nodes(centre);
  if (slots_.empty()) {
    // Nowhere in reach was standable even at the goal itself, which a
    // shoreline node beside a cliff can manage. Send them to its centre.
    NavPoint fallback;
    const float* d = grid_->direction(goal);
    fallback.dir[0] = d[0];
    fallback.dir[1] = d[1];
    fallback.dir[2] = d[2];
    fallback.node = goal;
    slots_.push_back(fallback);
  }

  // How far the formation spreads, so a follower the crowd stops at its edge
  // knows it is as close as it is going to get.
  double spread = 0.0;
  for (std::int32_t k = 0; k < group; ++k) {
    const NavPoint& slot = slots_[static_cast<std::size_t>(k) % slots_.size()];
    spread = std::max(spread, angle_between(slot.dir, centre));
  }
  const double settle_radius = spread * grid_->planet_radius() + 2.0 * kFollowerSpacing;

  std::int32_t routed = 0;
  for (std::int32_t k = 0; k < group; ++k) {
    const Member& member = members_[static_cast<std::size_t>(k)];
    Follower& follower = followers_[static_cast<std::size_t>(member.id)];
    // More followers than spots: double up, and let separation sort it out.
    const NavPoint& slot = slots_[static_cast<std::size_t>(k) % slots_.size()];

    follower.repaths = 0;
    follower.stalls = 0;
    follower.repath_cooldown = 0.0;
    follower.occupancy_repathed = false;
    follower.blocked_steps = 0;
    follower.lane = static_cast<double>(k) - static_cast<double>(group - 1) * 0.5;
    follower.settle_radius = settle_radius;
    if (member.start < 0 || !grid_->path_toward(member.start, path_scratch_)) {
      // No route — an island the follower cannot reach, or ground walled off by
      // slopes. It keeps standing where it is.
      stop(follower);
      continue;
    }
    // Its own route is the way in, then out along the flood to its spot.
    extend_to_slot(member.start, slot.node);
    follow(follower, member.start, path_scratch_, slot);
    ++routed;
  }

  return routed;
}

void FollowerSet::order_slots_by_approach(const double centre[3], std::int32_t goal) {
  // The formation fills from the far side back, so nobody has to push through
  // the ones who got there first. "Far" is along the way the group comes in:
  // where their routes reach the goal from, a few nodes out, which round a
  // headland or along a coast is nowhere near the straight line from home.
  double from[3] = {0.0, 0.0, 0.0};
  for (const Member& member : members_) {
    if (member.start < 0 || !grid_->path_toward(member.start, path_scratch_)) {
      continue;
    }
    // path_scratch_ ends at the goal; step back along it.
    const std::size_t length = path_scratch_.size();
    const std::int32_t node =
        length > kApproachNodes ? path_scratch_[length - 1 - kApproachNodes] : member.start;
    if (node == goal) {
      continue;
    }
    const float* d = grid_->direction(node);
    from[0] += d[0];
    from[1] += d[1];
    from[2] += d[2];
  }

  double inbound[3];
  if (!normalize3(from) || !tangent_towards(centre, from, inbound)) {
    // Already there, or arriving from all round: ring order will do.
    return;
  }

  slot_depth_.resize(slots_.size());
  slot_order_.resize(slots_.size());
  for (std::size_t i = 0; i < slots_.size(); ++i) {
    const double offset[3] = {
        slots_[i].dir[0] - centre[0],
        slots_[i].dir[1] - centre[1],
        slots_[i].dir[2] - centre[2],
    };
    slot_depth_[i] = -dot3(offset, inbound);
    slot_order_[i] = static_cast<std::int32_t>(i);
  }
  // Deepest first; ties keep ring order, so the result is deterministic.
  std::stable_sort(slot_order_.begin(), slot_order_.end(), [&](std::int32_t a, std::int32_t b) {
    return slot_depth_[static_cast<std::size_t>(a)] > slot_depth_[static_cast<std::size_t>(b)];
  });
  slot_sorted_.clear();
  for (const std::int32_t i : slot_order_) {
    slot_sorted_.push_back(slots_[static_cast<std::size_t>(i)]);
  }
  slots_.swap(slot_sorted_);
}

void FollowerSet::extend_to_slot(std::int32_t start, std::int32_t slot_node) {
  // The flood's tree, read from the spot back to the goal, then turned round.
  slot_chain_.clear();
  for (std::int32_t node = slot_node; node >= 0;
       node = flood_parent_[static_cast<std::size_t>(node)]) {
    slot_chain_.push_back(node);
  }
  std::reverse(slot_chain_.begin(), slot_chain_.end());

  // Where the way in first touches the chain, cut across to it: a follower
  // whose spot is on its own side of the goal should not walk to the goal and
  // back out. The start itself counts, so a follower already on the chain
  // never takes a step towards the goal at all.
  const auto on_chain = [&](std::int32_t node) -> std::ptrdiff_t {
    for (std::size_t i = 0; i < slot_chain_.size(); ++i) {
      if (slot_chain_[i] == node) {
        return static_cast<std::ptrdiff_t>(i);
      }
    }
    return -1;
  };

  std::ptrdiff_t join = on_chain(start);
  std::size_t keep = 0;
  for (std::size_t i = 0; join < 0 && i < path_scratch_.size(); ++i) {
    join = on_chain(path_scratch_[i]);
    keep = i + 1;
  }
  if (join < 0) {
    // The way in always ends at the goal, the chain's root; this only happens
    // for a slot the flood never reached, which plan_slots does not offer.
    return;
  }
  path_scratch_.resize(keep);
  path_scratch_.insert(path_scratch_.end(), slot_chain_.begin() + join + 1, slot_chain_.end());
}

}  // namespace inkulous
