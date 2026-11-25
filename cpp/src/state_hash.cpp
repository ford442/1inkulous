// Every system's contribution to the state hash, side by side, so one file
// shows what a replay or a lockstep peer is held to. A field left out here is
// a field two cores may disagree on without anyone noticing: when a system
// gains state that decides what it does next, add it below.
//
// Left out on purpose: render instance buffers and the followers' previous
// pose (drawing only), search and neighbour scratch (rebuilt before use),
// terrain dirty ranges (bookkeeping for the mesh copy) and the clock's
// accumulator (wall time, not simulated time).

#include "1inkulous/core.hpp"

namespace inkulous {
namespace {

void add_point(StateHash& out, const NavPoint& point) {
  out.add3(point.dir);
  out.add(point.node);
}

}  // namespace

void NavGrid::hash(StateHash& out) const {
  out.add(node_count_);
  out.add(link_count_);
  out.add(committed_);
  out.add(planet_radius_);
  out.add(max_slope_);
  out.add_all(directions_);
  out.add_all(neighbor_offsets_);
  out.add_all(neighbors_);
  // The ground itself, and where buildings stand on it.
  out.add_all(heights_);
  out.add_all(blocked_);
}

void Terrain::hash(StateHash& out) const { out.add(max_height_); }

void FollowerSet::hash(StateHash& out) const {
  out.add(speed_);
  for (const bool fallen : fallen_) {
    out.add(fallen);
  }
  out.add(static_cast<std::uint32_t>(followers_.size()));
  for (const Follower& f : followers_) {
    out.add3(f.dir);
    out.add3(f.heading);
    out.add(f.height);
    out.add(f.tribe);
    out.add(f.selected);
    out.add(f.shaman);
    out.add(f.casting);
    out.add(f.orders);
    out.add(static_cast<std::int32_t>(f.role));
    out.add(f.health);
    out.add(f.node);
    out.add(f.grounded);
    out.add(static_cast<std::uint32_t>(f.path.size()));
    for (const NavPoint& point : f.path) {
      add_point(out, point);
    }
    out.add(static_cast<std::uint32_t>(f.path_index));
    out.add(f.corner_wait);
    add_point(out, f.goal);
    out.add(f.settle_radius);
    out.add(f.best_waypoint_angle);
    out.add(f.stall_seconds);
    out.add(f.jammed_seconds);
    out.add(f.crowded);
    out.add(f.repath_cooldown);
    out.add(f.repaths);
    out.add(f.stalls);
    out.add(f.anchor_node);
    out.add(f.blocked_steps);
    out.add(f.occupancy_repathed);
    out.add(f.lane);
    out.add(f.hut);
    out.add(f.tree);
    out.add3(f.push);
  }
}

void HutSet::hash(StateHash& out) const {
  for (const bool used : free_dwelling_used_) {
    out.add(used);
  }
  out.add(static_cast<std::uint32_t>(huts_.size()));
  for (const Hut& hut : huts_) {
    out.add3(hut.dir);
    out.add3(hut.heading);
    out.add(hut.tribe);
    out.add(static_cast<std::int32_t>(hut.kind));
    out.add(hut.occupants);
    out.add(hut.breeding);
    out.add(hut.training);
    out.add(hut.node);
    out.add_all(hut.footprint);
    out.add(hut.door);
    out.add(hut.reach);
  }
}

void TreeSet::hash(StateHash& out) const {
  out.add(static_cast<std::uint32_t>(trees_.size()));
  for (const Tree& tree : trees_) {
    out.add3(tree.dir);
    out.add3(tree.heading);
    out.add(tree.size);
    out.add(tree.node);
    out.add(tree.progress);
  }
}

void Shamans::hash(StateHash& out) const {
  for (std::size_t tribe = 0; tribe < static_cast<std::size_t>(kMaxTribes); ++tribe) {
    out.add(mana_[tribe]);
    out.add(population_[tribe]);
    const Cast& cast = casts_[tribe];
    out.add(cast.active);
    out.add(static_cast<std::int32_t>(cast.spell));
    out.add3(cast.target.at);
    out.add3(cast.target.from);
    out.add(cast.elapsed);
    out.add(cast.orders);
    const CastEnd& end = ends_[tribe];
    out.add(end.count);
    out.add(static_cast<std::int32_t>(end.spell));
    out.add(static_cast<std::int32_t>(end.result));
    for (const double cooldown : cooldowns_[tribe]) {
      out.add(cooldown);
    }
  }
  // The last bridge's stamps: what landBridgePlan reports.
  out.add_all(stamps_);
}

void TribeAi::hash(StateHash& out) const {
  for (const Mind& mind : minds_) {
    out.add(mind.on);
    out.add3(mind.home);
    out.add(mind.wait);
    out.add(static_cast<std::int32_t>(mind.last));
    out.add(mind.done);
    out.add(mind.thinks);
    out.add(mind.pad);
    out.add_all(mind.spoiled);
  }
}

std::uint32_t Simulation::state_hash() const {
  StateHash out;
  out.add(step_count_);
  out.add(step_ms_);
  out.add(random_.seed());
  out.add(random_.state());
  nav_.hash(out);
  terrain_.hash(out);
  stores_.hash(out);
  followers_.hash(out);
  trees_.hash(out);
  huts_.hash(out);
  shamans_.hash(out);
  ai_.hash(out);
  return out.value();
}

}  // namespace inkulous
