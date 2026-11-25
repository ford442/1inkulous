// Followers: spawning, selection, walking an order, roles and health.

#include <vector>

#include <doctest/doctest.h>

#include "support.hpp"

using namespace testing_support;
using inkulous::Role;

namespace {

const Vec3 kHome = {0.0, 0.0, 1.0};

std::int32_t spawn(World& world, const Vec3& at, std::int32_t tribe = 0) {
  return world.sim.followers().spawn(at[0], at[1], at[2], tribe);
}

}  // namespace

TEST_CASE("a follower is placed on the walkable node nearest the direction") {
  World world;
  const std::int32_t id = spawn(world, kHome);
  REQUIRE(id == 0);
  CHECK(world.sim.followers().count() == 1);
  CHECK(angle(world.where(id), kHome) < 0.1);
  CHECK(world.sim.followers().tribe(id) == 0);
  CHECK(world.sim.followers().role(id) == Role::kBrave);
  CHECK(world.sim.followers().health(id) == inkulous::kFollowerHealth);
}

TEST_CASE("there is nowhere to spawn without land, or without a grid") {
  World sea(8, [](const Vec3&) { return 0.0; });
  CHECK(spawn(sea, kHome) == -1);

  inkulous::Simulation empty;
  CHECK(empty.followers().spawn(0.0, 0.0, 1.0, 0) == -1);
}

TEST_CASE("the follower ceiling is a number, not an overflow") {
  World world;
  for (std::int32_t i = 0; i < inkulous::kMaxFollowers; ++i) {
    REQUIRE(spawn(world, kHome) == i);
  }
  CHECK(spawn(world, kHome) == -1);
  CHECK(world.sim.followers().count() == inkulous::kMaxFollowers);
  world.sim.followers().clear();
  CHECK(world.sim.followers().count() == 0);
  CHECK(spawn(world, kHome) == 0);
}

TEST_CASE("selection counts, clears and ignores bad ids") {
  World world;
  const std::int32_t a = spawn(world, kHome);
  const std::int32_t b = spawn(world, kHome);
  auto& followers = world.sim.followers();
  followers.set_selected(a, true);
  followers.set_selected(b, true);
  followers.set_selected(99, true);
  followers.set_selected(-1, true);
  CHECK(followers.selected_count() == 2);
  CHECK(followers.selected(a));
  followers.set_selected(a, false);
  CHECK(followers.selected_count() == 1);
  followers.clear_selection();
  CHECK(followers.selected_count() == 0);
}

TEST_CASE("an order walks the follower to the point, not through one step") {
  World world;
  const std::int32_t id = spawn(world, kHome);
  auto& followers = world.sim.followers();
  followers.set_selected(id, true);
  const Vec3 start = world.where(id);

  const Vec3 goal = step_towards(kHome, {1.0, 0.0, 0.0}, 0.5);
  REQUIRE(followers.order_move_selected(goal[0], goal[1], goal[2]) == 1);
  CHECK(followers.is_walking(id));

  // Speed is world units per second along the surface, and the planet has
  // radius 1, so a second of walking is `speed` radians.
  world.run(1.0);
  const double travelled = angle(world.where(id), start);
  CHECK(within(travelled, followers.speed(), 0.1));
  CHECK(followers.is_walking(id));

  world.run_until(30.0, [&] { return !followers.is_walking(id); });
  CHECK_FALSE(followers.is_walking(id));
  CHECK(angle(world.where(id), goal) < 0.02);
}

TEST_CASE("a warrior walks faster than a brave") {
  auto walked = [](Role role) {
    World world;
    const std::int32_t id = spawn(world, kHome);
    world.sim.followers().set_role(id, role);
    world.sim.followers().set_selected(id, true);
    const Vec3 start = world.where(id);
    world.sim.followers().order_move_selected(0.0, 1.0, 0.0);
    world.run(1.0);
    return angle(world.where(id), start);
  };
  CHECK(walked(Role::kWarrior) > walked(Role::kBrave) * 1.1);
}

TEST_CASE("an order to a point the follower cannot reach goes nowhere") {
  // A ring of sea cuts the northern cap off: a follower on it cannot be sent
  // to the mainland, however it is asked.
  World world(16, [](const Vec3& d) {
    const double polar = std::acos(d[1]);
    return (polar > 0.5 && polar < 0.8) ? 0.0 : static_cast<double>(kLand);
  });
  const std::int32_t id = spawn(world, {0.0, 1.0, 0.0});
  auto& followers = world.sim.followers();
  followers.set_selected(id, true);
  CHECK(followers.order_move_selected(0.0, -1.0, 0.0) == 0);
  CHECK_FALSE(followers.is_walking(id));
  // Within the cap it goes.
  CHECK(followers.order_move_selected(0.2, 1.0, 0.0) == 1);
}

TEST_CASE("an order into the sea is an order to the shore") {
  World world(12, [](const Vec3& d) { return d[1] >= 0.0 ? static_cast<double>(kLand) : 0.0; });
  const std::int32_t id = spawn(world, {0.0, 1.0, 0.0});
  auto& followers = world.sim.followers();
  followers.set_selected(id, true);
  CHECK(followers.order_move_selected(0.0, -1.0, 0.0) == 1);
  world.run_until(60.0, [&] { return !followers.is_walking(id); });
  CHECK(world.where(id)[1] > -0.2);
}

TEST_CASE("a group order gives everyone a spot of their own") {
  World world;
  std::vector<std::int32_t> ids;
  for (int i = 0; i < 12; ++i) ids.push_back(spawn(world, kHome));
  auto& followers = world.sim.followers();
  for (const std::int32_t id : ids) followers.set_selected(id, true);

  const Vec3 goal = step_towards(kHome, {0.0, 1.0, 0.0}, 0.6);
  CHECK(followers.order_move_selected(goal[0], goal[1], goal[2]) == 12);
  world.run_until(60.0, [&] {
    for (const std::int32_t id : ids) {
      if (followers.is_walking(id)) return false;
    }
    return true;
  });

  // All arrived, near the goal, and not on top of each other.
  double closest = 10.0;
  for (std::size_t i = 0; i < ids.size(); ++i) {
    CHECK_FALSE(followers.is_walking(ids[i]));
    CHECK(angle(world.where(ids[i]), goal) < 0.35);
    for (std::size_t j = i + 1; j < ids.size(); ++j) {
      closest = std::min(closest, angle(world.where(ids[i]), world.where(ids[j])));
    }
  }
  CHECK(closest > inkulous::kFollowerSpacing * 0.5);
}

TEST_CASE("a stack of followers on one spot comes apart") {
  World world;
  const std::int32_t a = spawn(world, kHome);
  const std::int32_t b = spawn(world, kHome);
  REQUIRE(a >= 0);
  REQUIRE(b >= 0);
  world.run(3.0);
  CHECK(angle(world.where(a), world.where(b)) > 1e-3);
}

TEST_CASE("remove takes a follower out of the set and shifts the rest down") {
  World world;
  const std::int32_t a = spawn(world, kHome, 0);
  const std::int32_t b = spawn(world, {1.0, 0.0, 0.0}, 1);
  spawn(world, {0.0, 1.0, 0.0}, 2);
  REQUIRE(world.sim.followers().count() == 3);
  (void)a;
  world.sim.followers().remove(a);
  CHECK(world.sim.followers().count() == 2);
  // Ids are dense indices: what was `b` is now 0, still tribe 1.
  CHECK(world.sim.followers().tribe(0) == 1);
  (void)b;
}

TEST_CASE("roles and health are set within their limits") {
  World world;
  const std::int32_t id = spawn(world, kHome);
  auto& followers = world.sim.followers();
  CHECK(followers.set_role(id, Role::kWarrior));
  CHECK(followers.role(id) == Role::kWarrior);
  CHECK_FALSE(followers.set_role(99, Role::kWarrior));

  followers.set_health(id, 1000.0);
  CHECK(followers.health(id) == inkulous::kFollowerHealth);
  followers.set_health(id, -5.0);
  CHECK(followers.health(id) == 0.0);
}

TEST_CASE("a follower at zero health is gone on the next step") {
  World world;
  const std::int32_t id = spawn(world, kHome);
  world.sim.followers().set_health(id, 0.0);
  world.run(0.2);
  CHECK(world.sim.followers().count() == 0);
}

TEST_CASE("the instance buffer packs position, heading flags for the renderer") {
  World world;
  const std::int32_t id = spawn(world, kHome);
  auto& followers = world.sim.followers();
  followers.set_selected(id, true);
  followers.refresh_instances();

  const float* row = followers.instances() + id * inkulous::kFollowerInstanceFloats;
  // The first three floats are the feet: on the surface, so radius ~ 1 + height.
  const double radius =
      std::sqrt(static_cast<double>(row[0]) * row[0] + static_cast<double>(row[1]) * row[1] +
                static_cast<double>(row[2]) * row[2]);
  CHECK(within(radius, 1.0 + static_cast<double>(kLand), 0.002));
  const auto flags = static_cast<std::int32_t>(row[7]);
  CHECK((flags & inkulous::kFlagSelected) != 0);
  CHECK((flags & inkulous::kFlagWalking) == 0);
  CHECK((flags & inkulous::kFlagShaman) == 0);
}
