// Health and the fight: warriors wear down the nearest enemy in reach on the
// fixed step. Braves never fight.

#include "1inkulous/followers.hpp"

#include <algorithm>
#include <cmath>

#include "follower_internal.hpp"

namespace inkulous {

void FollowerSet::set_health(std::int32_t id, double health) {
  if (id < 0 || id >= count() || !std::isfinite(health)) {
    return;
  }
  followers_[static_cast<std::size_t>(id)].health =
      health < 0.0 ? 0.0 : (health > kFollowerHealth ? kFollowerHealth : health);
}

void FollowerSet::fight(double dt_seconds) {
  // Struck all at once: everyone picks a target from where the step left
  // them, then the blows land, so who is handled first does not decide who
  // lives. Two warriors on one enemy take it down twice as fast.
  bool anyone = false;
  const std::int32_t total = count();
  damage_scratch_.assign(static_cast<std::size_t>(total), 0.0);
  for (std::int32_t id = 0; id < total; ++id) {
    const Follower& self = followers_[static_cast<std::size_t>(id)];
    const RoleStats& stats = role_stats(self.role);
    if (!(stats.damage_per_second > 0.0) || self.health <= 0.0) {
      continue;
    }
    std::int32_t target = -1;
    double nearest = 0.0;
    for_each_near(id, stats.reach, [&](std::int32_t other, const double*, double distance) {
      const Follower& them = followers_[static_cast<std::size_t>(other)];
      if (them.tribe == self.tribe || them.health <= 0.0) {
        return;
      }
      if (target < 0 || distance < nearest || (distance == nearest && other < target)) {
        target = other;
        nearest = distance;
      }
    });
    if (target >= 0) {
      damage_scratch_[static_cast<std::size_t>(target)] += stats.damage_per_second * dt_seconds;
      anyone = true;
    }
  }
  if (anyone) {
    for (std::int32_t id = 0; id < total; ++id) {
      followers_[static_cast<std::size_t>(id)].health -=
          damage_scratch_[static_cast<std::size_t>(id)];
    }
  }

  // The fallen leave the set, from the top so the ids still to visit hold.
  // A shaman among them takes her tribe out of the match.
  bool removed = false;
  std::array<bool, kMaxTribes> shaman_fell{};
  for (std::int32_t id = count() - 1; id >= 0; --id) {
    const Follower& dead = followers_[static_cast<std::size_t>(id)];
    if (dead.health <= 0.0) {
      if (dead.shaman && valid_tribe(dead.tribe)) {
        shaman_fell[static_cast<std::size_t>(dead.tribe)] = true;
      }
      followers_.erase(followers_.begin() + id);
      removed = true;
    }
  }
  for (std::int32_t tribe = 0; tribe < kMaxTribes; ++tribe) {
    if (!shaman_fell[static_cast<std::size_t>(tribe)]) {
      continue;
    }
    fallen_[static_cast<std::size_t>(tribe)] = true;
    // Her people put down what they were doing: no route, no hut, no tree,
    // and out of the player's selection.
    for (Follower& follower : followers_) {
      if (follower.tribe == tribe) {
        follower.selected = false;
        follower.hut = -1;
        follower.tree = -1;
        stop(follower);
      }
    }
  }
  if (removed) {
    refresh_instances();
  }
}

}  // namespace inkulous
