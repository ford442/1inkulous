// The fight: warriors wear down the nearest enemy in reach; braves never fight.

#include <doctest/doctest.h>

#include "support.hpp"

using namespace testing_support;
using inkulous::Role;

namespace {

const Vec3 kHome = {0.0, 0.0, 1.0};

std::int32_t spawn(World& world, const Vec3& at, std::int32_t tribe, Role role = Role::kBrave) {
  const std::int32_t id = world.sim.followers().spawn(at[0], at[1], at[2], tribe);
  if (role != Role::kBrave) world.sim.followers().set_role(id, role);
  return id;
}

}  // namespace

TEST_CASE("two braves of different tribes side by side do not fight") {
  World world;
  const std::int32_t a = spawn(world, kHome, 0);
  const std::int32_t b = spawn(world, kHome, 1);
  world.run(3.0);
  CHECK(world.sim.followers().health(a) == inkulous::kFollowerHealth);
  CHECK(world.sim.followers().health(b) == inkulous::kFollowerHealth);
}

TEST_CASE("a warrior wears an enemy down on the fixed step") {
  World world;
  const std::int32_t warrior = spawn(world, kHome, 0, Role::kWarrior);
  const std::int32_t enemy = spawn(world, kHome, 1);
  REQUIRE(warrior >= 0);
  REQUIRE(enemy >= 0);

  world.run(1.0);
  const double dps = inkulous::role_stats(Role::kWarrior).damage_per_second;
  CHECK(within(world.sim.followers().health(enemy), inkulous::kFollowerHealth - dps, 0.05));
  // The warrior is unhurt: the enemy is a brave.
  CHECK(world.sim.followers().health(warrior) == inkulous::kFollowerHealth);

  // Five seconds in all kills it, and it leaves the set.
  world.run(inkulous::kFollowerHealth / dps);
  CHECK(world.sim.followers().count() == 1);
  CHECK(world.sim.followers().role(0) == Role::kWarrior);
}

TEST_CASE("a warrior leaves its own tribe alone") {
  World world;
  const std::int32_t warrior = spawn(world, kHome, 0, Role::kWarrior);
  const std::int32_t friend_ = spawn(world, kHome, 0);
  world.run(3.0);
  CHECK(world.sim.followers().health(warrior) == inkulous::kFollowerHealth);
  CHECK(world.sim.followers().health(friend_) == inkulous::kFollowerHealth);
}

TEST_CASE("an enemy out of reach is not touched") {
  World world;
  spawn(world, kHome, 0, Role::kWarrior);
  const Vec3 far_away = step_towards(kHome, {1.0, 0.0, 0.0}, 0.5);
  const std::int32_t enemy = spawn(world, far_away, 1);
  world.run(3.0);
  CHECK(world.sim.followers().health(enemy) == inkulous::kFollowerHealth);
}

TEST_CASE("two warriors fight each other to the death, and one is left") {
  World world;
  spawn(world, kHome, 0, Role::kWarrior);
  spawn(world, kHome, 1, Role::kWarrior);
  world.run(inkulous::kFollowerHealth / inkulous::role_stats(Role::kWarrior).damage_per_second +
            2.0);
  CHECK(world.sim.followers().count() <= 1);
}

TEST_CASE("a warrior's reach fits inside the neighbour index") {
  // The core's static_assert says the same; this is the number it protects.
  CHECK(inkulous::role_stats(Role::kWarrior).reach < inkulous::kFollowerSpacing * 3.0 * 0.75);
}
