#include "1inkulous/followers.hpp"

#include <algorithm>
#include <cmath>

namespace inkulous {
namespace {

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
// Share of an overlap a walker takes when it meets someone standing still:
// none. The bystander shuffles aside if the ground lets it, and if it is
// pinned — on a spit of land, say — the walker squeezes past rather than be
// held up behind someone who is never going to move.
constexpr double kWalkerShare = 0.0;
// A walker that has not got closer to its waypoint for this long is stuck.
constexpr double kStallSeconds = 1.5;
// How far back along the group's routes to look for the way they arrive.
constexpr std::size_t kApproachNodes = 4;
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

double clamp_unit(double value) {
  return value < -1.0 ? -1.0 : (value > 1.0 ? 1.0 : value);
}

double dot3(const double a[3], const double b[3]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

bool normalize3(double v[3]) {
  const double length = std::sqrt(dot3(v, v));
  if (!(length > 1e-12)) {
    return false;
  }
  v[0] /= length;
  v[1] /= length;
  v[2] /= length;
  return true;
}

void cross3(const double a[3], const double b[3], double out[3]) {
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
}

// Removes the component of `v` along the unit normal `n`.
void flatten(double v[3], const double n[3]) {
  const double along = dot3(v, n);
  v[0] -= n[0] * along;
  v[1] -= n[1] * along;
  v[2] -= n[2] * along;
}

// Unit tangent at `from` pointing along the great circle towards `to`. False
// when the two coincide.
bool tangent_towards(const double from[3], const double to[3], double out[3]) {
  out[0] = to[0];
  out[1] = to[1];
  out[2] = to[2];
  flatten(out, from);
  return normalize3(out);
}

// `from` carried `angle` radians along the unit tangent `tangent`.
void rotate_along(const double from[3], const double tangent[3], double angle, double out[3]) {
  const double c = std::cos(angle);
  const double s = std::sin(angle);
  out[0] = from[0] * c + tangent[0] * s;
  out[1] = from[1] * c + tangent[1] * s;
  out[2] = from[2] * c + tangent[2] * s;
  normalize3(out);
}

double angle_between(const double a[3], const double b[3]) {
  const double dx = a[0] - b[0];
  const double dy = a[1] - b[1];
  const double dz = a[2] - b[2];
  const double chord = std::sqrt(dx * dx + dy * dy + dz * dz);
  return 2.0 * std::asin(clamp_unit(chord * 0.5));
}

// Two unit tangents at the unit vector `n`.
void tangent_basis(const double n[3], double e1[3], double e2[3]) {
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

int quantize_axis(double value, int bins) {
  int bin = static_cast<int>(std::floor((value + 1.0) * 0.5 * bins));
  return bin < 0 ? 0 : (bin >= bins ? bins - 1 : bin);
}

std::uint32_t pack_cell(int x, int y, int z, int bins) {
  return (static_cast<std::uint32_t>(x) * static_cast<std::uint32_t>(bins) +
          static_cast<std::uint32_t>(y)) *
             static_cast<std::uint32_t>(bins) +
         static_cast<std::uint32_t>(z);
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
  follower.best_waypoint_angle = follower.path.empty()
                                 ? 0.0
                                 : angle_between(follower.dir, follower.path.front().dir);
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
  return route_to(follower, goal);
}

void FollowerSet::plan_slots(const double centre[3],
                             std::int32_t goal_node,
                             std::int32_t wanted) {
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
  constexpr double kPi = 3.14159265358979323846;
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

  members_.clear();
  start_scratch_.clear();
  for (std::int32_t id = 0; id < count(); ++id) {
    const Follower& follower = followers_[static_cast<std::size_t>(id)];
    if (follower.selected) {
      const std::int32_t start = start_node(follower);
      members_.push_back(Member{id, start, 0.0});
      start_scratch_.push_back(start);
    }
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

  const std::int32_t group = static_cast<std::int32_t>(members_.size());
  plan_slots(centre, goal, group);
  order_slots_by_approach(centre, goal);
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
    const std::int32_t node = length > kApproachNodes
                                  ? path_scratch_[length - 1 - kApproachNodes]
                                  : member.start;
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
    const bool escape = !follower.grounded && ground.on_mesh && grid_->walkable(node) &&
                        (node == follower.node || follower.node < 0 ||
                         grid_->passable(follower.node, node));
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
  double budget = speed_ * dt_seconds / radius;
  follower.crowded = false;
  follower.corner_wait -= dt_seconds;
  const double was[3] = {follower.dir[0], follower.dir[1], follower.dir[2]};

  while (budget > 1e-12 && walking(follower)) {
    const NavPoint waypoint = follower.path[follower.path_index];
    const bool last_leg = follower.path_index + 1 == follower.path.size();
    const double angle = angle_between(follower.dir, waypoint.dir);

    if (angle <= budget) {
      if (!try_move(follower, waypoint.dir, kStepSupport)) {
        blocked(follower);
        break;
      }
      budget -= angle;
      if (last_leg) {
        stop(follower);
        break;
      }
      follower.path_index += 1;
      follower.corner_wait = 0.0;
      follower.repaths = 0;
      follower.best_waypoint_angle =
          angle_between(follower.dir, follower.path[follower.path_index].dir);
      follower.stall_seconds = 0.0;
      continue;
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
    swerve = std::max(-kMaxSwerve, std::min(kMaxSwerve, swerve));
    budget *= pace;
    if (!(budget > 1e-12)) {
      break;
    }

    double target[3];
    bool moved = false;
    if (swerve != 0.0) {
      double heading[3] = {
          desired[0] + side[0] * swerve,
          desired[1] + side[1] * swerve,
          desired[2] + side[2] * swerve,
      };
      normalize3(heading);
      rotate_along(follower.dir, heading, budget, target);
      moved = try_move(follower, target, kRouteSupport);
    }
    if (!moved) {
      rotate_along(follower.dir, desired, budget, target);
      moved = try_move(follower, target, kStepSupport);
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
      rotate_along(follower.dir, slide, budget, target);
      moved = try_move(follower, target, kRouteSupport);
    }
    if (!moved) {
      blocked(follower);
      break;
    }
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
    const double scale = (length > kMaxPush ? kMaxPush / length : 1.0) / radius;
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
    if (walking(follower)) flags |= kFlagWalking;
    out[7] = static_cast<float>(flags);
  }
}

}  // namespace inkulous
