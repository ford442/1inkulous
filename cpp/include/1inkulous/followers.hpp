#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "1inkulous/nav.hpp"
#include "1inkulous/state_hash.hpp"
#include "1inkulous/tribes.hpp"

// Followers: the first units on the planet.
//
// A follower is a point on the sphere — a unit direction plus a height above
// sea level — walking a list of waypoints. Everything about them lives here in
// the core; TypeScript spawns them, hands them orders, and reads back a packed
// instance buffer to draw. Nothing is copied across the boundary per frame
// except that one pointer.
//
// A step has three passes. Walkers steer towards their next waypoint, bending
// round anyone in their way and refusing a step that would land on a body
// already there; then everyone standing too close to someone else is pushed
// apart; then everyone's feet are put back on the ground. Positions are free
// on the surface, not snapped to nodes, so a group spreads around a waypoint
// instead of queueing on one vertex. A body that cannot take that step for
// several fixed steps repaths once from the node it is anchored to. A fourth
// pass is the fight: every warrior strikes the nearest enemy in reach, and
// anyone left with no health is taken out of the set.

namespace inkulous {

// Floats per follower in the render instance buffer:
//   0..2  world position (already scaled by radius + height)
//   3..5  unit heading, tangent to the surface
//   6     tribe index, as a float
//   7     flags bitfield, as a float — see kFlag*, with the Role in bits
//         kRoleShift and up
//   8..10 world position as the last fixed step began
//   11..13 heading as the last fixed step began
// The renderer draws each follower between the two poses, by how far the
// clock has got towards the next step, so motion is smooth at any display
// rate. Someone put somewhere rather than walked there — spawned, set down,
// shoved — has both poses equal, and is drawn where they are.
constexpr std::int32_t kFollowerInstanceFloats = 14;
constexpr std::int32_t kInstancePrevOffset = 8;

constexpr std::int32_t kFlagSelected = 1 << 0;
constexpr std::int32_t kFlagWalking = 1 << 1;
// The tribe's shaman: walks, paths and is selected like anyone else, but is
// drawn apart and never goes into a hut. See shaman.hpp.
constexpr std::int32_t kFlagShaman = 1 << 2;
// The role sits above the flags, three bits wide: room for the preachers and
// firewarriors that come later without another instance float.
constexpr std::int32_t kRoleShift = 3;
constexpr std::int32_t kRoleMask = 0x7 << kRoleShift;
// A shaman standing to cast a spell, for as long as the cast lasts. Set and
// cleared by Shamans; above the role bits so roles keep their room.
constexpr std::int32_t kFlagCasting = 1 << 6;

// What a follower is for. Everyone is born a brave; a training hut turns a
// brave into a warrior. The shaman is not a role but a flag on a brave.
// Values cross the ABI as ints.
enum class Role : std::int32_t {
  // Gathers, builds a village's population, goes into huts. Does not fight.
  kBrave = 0,
  // Fights. Does not chop or go into huts.
  kWarrior = 1,
};
constexpr std::int32_t kRoleCount = 2;

// What a role changes, and nothing else: how fast it walks and how hard it
// hits. Combat is the smallest thing that makes the role matter — a warrior
// in reach of an enemy wears down its health on the fixed step, and at zero
// the enemy is gone. No formations, no ranged, no fire.
struct RoleStats {
  // Multiplies the set's walking speed.
  double speed;
  // Health taken per second from one enemy in reach. Zero: does not fight.
  double damage_per_second;
  // Centre to centre, in world units along the ground.
  double reach;
};

// Health everyone starts with, whatever the role.
constexpr double kFollowerHealth = 100.0;

constexpr RoleStats kRoleStats[kRoleCount] = {
    // Brave.
    {1.0, 0.0, 0.0},
    // Warrior: a shade quicker, five seconds to cut down a brave alone, and
    // a reach that covers anyone standing a spacing or so off.
    {1.25, 20.0, 0.04},
};

inline const RoleStats& role_stats(Role role) {
  const auto index = static_cast<std::int32_t>(role);
  return kRoleStats[index >= 0 && index < kRoleCount ? index : 0];
}

// World units per second along the surface. On a unit-radius planet a follower
// crosses a typical island in a few seconds and laps the world in a minute or
// two — small enough to read as a person, quick enough to play with.
constexpr double kDefaultFollowerSpeed = 0.06;

// Closest two followers will stand, centre to centre, in world units. The pawn
// is 0.016 across on the unit planet, so this leaves a visible gap.
constexpr double kFollowerSpacing = 0.024;

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

  // Sends every selected follower to the terrain point under `x, y, z`. The
  // group is given a spot each, packed round the point, and each one paths to
  // its own. Returns how many found a route.
  std::int32_t order_move_selected(double x, double y, double z);
  // The same order for an explicit list of ids. Every listed follower drops
  // any hut it was heading into; an enter order sets that again afterwards.
  std::int32_t order_move(const std::vector<std::int32_t>& ids, double x, double y, double z);

  // Places a follower on the exact direction when the ground there will hold
  // it, and on the nearest walkable node otherwise. Same result as spawn().
  std::int32_t spawn_at(const double dir[3], std::int32_t tribe);

  // Called once a building has claimed nodes. Anyone whose ground now leans
  // on a blocked node is set down on the nearest free node, and anyone
  // walking is routed again, so nobody is left inside a hut or bound for a
  // spot under one.
  void step_off_blocked();

  // Takes a follower out of the world — into a hut. Ids above it shift down
  // by one, so callers walking the set remove from the top.
  void remove(std::int32_t id);

  // Ground edits from inside the core — a spell — and what they do to the
  // people standing on it. Each takes a disc: a unit-or-not direction and an
  // angular radius.
  //
  // Everyone inside the disc is pushed out along the ground, away from its
  // centre, to `beyond` radians past the rim: onto that point when it can be
  // stood on, the nearest walkable node to it otherwise. Anyone walking is
  // routed again from where they land. Returns how many moved.
  std::int32_t shove(const double centre[3], double angular_radius, double beyond);
  // Everyone near the disc whose ground can no longer hold them — water, a
  // hut, a cliff — is set down on the nearest walkable node and stopped.
  // Returns how many.
  std::int32_t strand(const double centre[3], double angular_radius);
  // Everyone walking a route that passes over the disc is routed again to
  // their goal (or the nearest walkable node to it), and stopped if there is
  // no longer a way.
  void reroute_across(const double centre[3], double angular_radius);

  // Read access for the systems that act on followers from outside: huts.
  // `id` must be in range.
  const double* direction(std::int32_t id) const {
    return followers_[static_cast<std::size_t>(id)].dir;
  }
  std::int32_t tribe(std::int32_t id) const {
    return followers_[static_cast<std::size_t>(id)].tribe;
  }
  bool selected(std::int32_t id) const {
    return followers_[static_cast<std::size_t>(id)].selected;
  }
  bool is_walking(std::int32_t id) const {
    return walking(followers_[static_cast<std::size_t>(id)]);
  }
  bool is_shaman(std::int32_t id) const {
    return followers_[static_cast<std::size_t>(id)].shaman;
  }
  // Move orders this follower has been given, ever. Something waiting on a
  // follower (a shaman's cast) notes it and treats any change as a new order.
  std::uint32_t orders(std::int32_t id) const {
    return followers_[static_cast<std::size_t>(id)].orders;
  }
  bool casting(std::int32_t id) const {
    return followers_[static_cast<std::size_t>(id)].casting;
  }
  // Sets kFlagCasting. False for a bad id.
  bool set_casting(std::int32_t id, bool casting);
  // Stops follower `id` where it stands, dropping its route but not its hut
  // or tree. Not an order: orders() does not change.
  void halt(std::int32_t id);
  Role role(std::int32_t id) const { return followers_[static_cast<std::size_t>(id)].role; }
  bool is_brave(std::int32_t id) const { return role(id) == Role::kBrave; }
  double health(std::int32_t id) const {
    return followers_[static_cast<std::size_t>(id)].health;
  }

  // Changes follower `id`'s role. A training hut does this to the warrior it
  // lets out; tests and scenarios may do it directly. False for a bad id or
  // role, or for the shaman, who stays what she is.
  bool set_role(std::int32_t id, Role role);
  // Sets health, clamped to [0, kFollowerHealth]. One set to 0 is removed on
  // the next step. For tests and scenario setup.
  void set_health(std::int32_t id, double health);

  // Makes follower `id` its tribe's shaman. False for a bad id.
  bool make_shaman(std::int32_t id);

  // Whether `tribe`'s shaman has been killed this match. Her people stop
  // taking orders from that step on: they are deselected and stopped, a
  // selection or an order that names them passes them over, and no order
  // call (move, enter, chop, eject) moves them again. Cleared with the set.
  bool fallen(std::int32_t tribe) const {
    return valid_tribe(tribe) && fallen_[static_cast<std::size_t>(tribe)];
  }
  // Whether follower `id` still answers to orders: in range, and of a tribe
  // whose shaman stands (or never had one).
  bool takes_orders(std::int32_t id) const {
    return id >= 0 && id < count() && !fallen(tribe(id));
  }
  // Id of `tribe`'s shaman, or -1. Ids shift as followers go into huts, so
  // look her up rather than keeping the number.
  std::int32_t shaman(std::int32_t tribe) const;

  // The hut a follower has been ordered into, or -1. Huts own the meaning;
  // the follower only carries the number and loses it on any other order.
  std::int32_t hut(std::int32_t id) const;
  void set_hut(std::int32_t id, std::int32_t hut);
  void clear_huts();

  // The tree a follower has been sent to chop, or -1. Trees own the meaning,
  // as huts do; any other order drops it.
  std::int32_t tree(std::int32_t id) const;
  void set_tree(std::int32_t id, std::int32_t tree);
  // Tree `tree` has gone and the ids above it have shifted down by one.
  void tree_removed(std::int32_t tree);
  void clear_trees();

  // Advances every follower by one fixed step.
  void step(double dt_seconds);
  // Notes everyone's pose as a step begins, for the previous pose in the
  // instance buffer. Called by the clock before every step, before any system
  // moves anyone. Drawing only: no part of the simulation reads it.
  void mark_step();

  double speed() const { return speed_; }
  void set_speed(double speed) { speed_ = speed > 0.0 ? speed : kDefaultFollowerSpeed; }

  // Copies the waypoints a follower has still to reach into `out`, the last
  // being where it will stop; empty when it is idle. False for a bad id.
  bool route(std::int32_t id, std::vector<NavPoint>& out) const;

  // Packed instance data, refreshed by `refresh_instances`.
  const float* instances() const { return instances_.data(); }
  void refresh_instances();

  // Mixes in everything of this that decides the next step. See state_hash.hpp.
  void hash(StateHash& out) const;

 private:
  struct Follower {
    double dir[3] = {0.0, 1.0, 0.0};
    double heading[3] = {1.0, 0.0, 0.0};
    double height = 0.0;
    std::int32_t tribe = 0;
    bool selected = false;
    bool shaman = false;
    bool casting = false;
    // Bumped by every move order; see orders().
    std::uint32_t orders = 0;
    Role role = Role::kBrave;
    double health = kFollowerHealth;

    // Node nearest `dir`, followed as the follower moves.
    std::int32_t node = -1;
    // Whether the ground under it is ground it could have walked onto. Pushed
    // or sculpted off it, a follower may walk back but not further astray.
    bool grounded = true;

    // Waypoints still to reach; path_index points at the one being walked to.
    std::vector<NavPoint> path;
    std::size_t path_index = 0;
    // Seconds until it next looks past the corner it is walking to, so the
    // line test runs a few times a second near a corner rather than every step.
    double corner_wait = 0.0;

    // Where the order put it: the final waypoint, kept for re-routing.
    NavPoint goal;
    // Within this of the goal, a follower that the crowd has stopped short is
    // done rather than stuck. Scales with the size of the group it came with.
    double settle_radius = 0.0;
    // Progress watch: the closest it has been to its current waypoint, and for
    // how long it has failed to beat that.
    double best_waypoint_angle = 0.0;
    double stall_seconds = 0.0;
    // How long it has waited, stalled, with others close round it.
    double jammed_seconds = 0.0;
    // Whether anyone stood close by when it last steered.
    bool crowded = false;
    double repath_cooldown = 0.0;
    // Re-routes since it last reached a waypoint, and stalls since the order.
    std::int32_t repaths = 0;
    std::int32_t stalls = 0;
    // Node the current leg set out from. Occupancy repaths from here, once.
    std::int32_t anchor_node = -1;
    // Fixed steps in a row that could not be taken because a body owns them.
    std::int32_t blocked_steps = 0;
    // The single occupancy repath this order is allowed has been spent.
    bool occupancy_repathed = false;
    // Lateral place in the group, in spacings left of the file. Zero alone.
    // Intermediate legs steer aside by this so a file spreads round a vertex.
    double lane = 0.0;
    // Hut this follower was ordered into, or -1. See HutSet.
    std::int32_t hut = -1;
    // Tree this follower was sent to chop, or -1. See TreeSet.
    std::int32_t tree = -1;

    // Separation push gathered this step, world units in the tangent plane.
    double push[3] = {0.0, 0.0, 0.0};

    // Drawing only, and so not hashed: the pose (world position, heading) as
    // the last step began. `placed` means it was put where it is since then,
    // not walked there, and is drawn without interpolating.
    float drawn[6] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
    bool placed = true;
  };

  // The pose the instance buffer draws: world position, then heading.
  void pose(const Follower& follower, float out[6]) const;

  // One entry per follower in the neighbour index, sorted by cell.
  struct Cell {
    std::uint32_t key;
    std::int32_t id;
  };
  // One follower in an order being planned.
  struct Member {
    std::int32_t id;
    std::int32_t start;
    // Along the ground to the goal; infinite if there is no way.
    double distance;
  };

  // A cell's run of entries in the sorted index; `count == 0` is an empty slot.
  struct Run {
    std::uint32_t key = 0;
    std::int32_t start = 0;
    std::int32_t count = 0;
  };

  bool walking(const Follower& follower) const {
    return follower.path_index < follower.path.size();
  }

  void stop(Follower& follower);
  // Puts `follower` on node `node`, feet on the ground, facing along it.
  void set_down(Follower& follower, std::int32_t node);
  // Routes a walker again to its goal, moved to the nearest walkable node if
  // the goal itself is no longer walkable. Stops it if there is no way.
  void reroute(Follower& follower);
  // The node a follower's route leaves from: its own, or the nearest land.
  std::int32_t start_node(const Follower& follower) const;
  // Sets `follower` walking `nodes` (find_path's format, from `start`) to
  // `goal`, string-pulled from where it actually stands.
  void follow(Follower& follower,
              std::int32_t start,
              const std::vector<std::int32_t>& nodes,
              const NavPoint& goal);
  // Paths `follower` from where it stands to `goal`. False if there is no way.
  bool route_to(Follower& follower, const NavPoint& goal);
  // Rewrites path_scratch_, a route from `start` to the order's goal node, to
  // end at `slot_node` instead, by way of the flood plan_slots ran.
  void extend_to_slot(std::int32_t start, std::int32_t slot_node);
  // Re-routes to the existing goal after being blocked or stalled.
  bool repath(Follower& follower);
  // Moves to `target` if the ground there is standable to `support`: the
  // loose kStepSupport for walking a leg the route already checked, the strict
  // kRouteSupport for anything that leaves it — a swerve, a slide, a shove.
  bool try_move(Follower& follower, const double target[3], double support);
  // True when some other body already sits on the segment from `id` to
  // `target`. A walker going the same way does not count: that is a queue,
  // and the pace limit handles it. A stack sharing `id`'s own end of the
  // segment does not count either; separation peels that apart.
  bool segment_taken(std::int32_t id, const double target[3]) const;
  void steer(std::int32_t id, double dt_seconds);
  void blocked(Follower& follower);
  // The step was refused because a body owns it. After several such steps,
  // repath once from `anchor_node`, then stop if that is still shut.
  void held(Follower& follower);
  void watch_progress(Follower& follower, double dt_seconds);
  void separate();
  void settle(Follower& follower);
  // Every warrior strikes the nearest enemy in its reach; then anyone with no
  // health left is taken out of the set. Needs the neighbour index current.
  void fight(double dt_seconds);

  // Lays out up to `wanted` standing spots round `centre`, reachable from
  // `goal_node`, centre first. Fills `slots_`.
  void plan_slots(const double centre[3], std::int32_t goal_node, std::int32_t wanted);
  // Slides any slot that would share a weld id onto a free flooded neighbour,
  // when that neighbour is still local and keeps the formation spacing. The
  // slot on the clicked point itself is left there.
  void claim_distinct_nodes(const double centre[3]);
  // Reorders `slots_` far side first, as seen from the way `members_` will
  // arrive. Needs the order's search_toward still current.
  void order_slots_by_approach(const double centre[3], std::int32_t goal);

  // Neighbour index over follower positions: a grid hash of directions whose
  // cells are at least `reach` world units across, rebuilt by sorting.
  void build_index(double reach);
  std::size_t find_run(std::uint32_t key) const;
  template <typename Visit>
  void for_each_near(std::int32_t id, double reach, Visit&& visit) const;

  NavGrid* grid_ = nullptr;
  std::vector<Follower> followers_;
  std::vector<float> instances_;
  double speed_ = kDefaultFollowerSpeed;

  // Scratch kept allocated between calls.
  std::vector<std::int32_t> path_scratch_;
  std::vector<NavPoint> slots_;
  std::vector<NavPoint> slot_sorted_;
  std::vector<double> slot_depth_;
  std::vector<std::int32_t> slot_order_;
  std::vector<Member> members_;
  std::vector<std::int32_t> flood_queue_;
  std::vector<std::uint32_t> flood_stamp_;
  // Each flooded node's parent, one step nearer the goal.
  std::vector<std::int32_t> flood_parent_;
  std::vector<std::int32_t> slot_chain_;
  std::vector<std::int32_t> start_scratch_;
  // claim_distinct_nodes: which slot owns a node, or -1. Sized to the graph.
  std::vector<std::int32_t> node_claim_;
  std::vector<std::int32_t> claim_order_;
  // fight: health each follower loses this step, by id.
  std::vector<double> damage_scratch_;
  std::uint32_t flood_generation_ = 0;
  // See fallen().
  std::array<bool, kMaxTribes> fallen_{};
  std::vector<Cell> cells_;
  std::vector<Run> runs_;
  int index_bins_ = 1;
};

}  // namespace inkulous
