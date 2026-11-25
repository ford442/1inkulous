// Huts: where they may stand, what they block, who goes in and what comes out.

#include <vector>

#include <doctest/doctest.h>

#include "support.hpp"

using namespace testing_support;
using inkulous::HutKind;
using inkulous::HutSite;

namespace {

const Vec3 kHome = {0.0, 0.0, 1.0};

std::int32_t build(World& world,
                   const Vec3& at,
                   std::int32_t tribe,
                   HutKind kind = HutKind::kDwelling) {
  return world.sim.huts().place(at[0], at[1], at[2], 0.0, 1.0, 0.0, tribe, kind);
}

HutSite site(World& world, const Vec3& at, std::int32_t tribe, HutKind kind = HutKind::kDwelling) {
  return world.sim.huts().check_site(at[0], at[1], at[2], kind, tribe);
}

// The nodes of a hut's footprint: blocked ones near the point.
std::int32_t blocked_near(World& world, const Vec3& at, double radius) {
  std::int32_t count = 0;
  for (std::int32_t node = 0; node < world.sim.nav().node_count(); ++node) {
    const float* d = world.sim.nav().direction(node);
    const double dir[3] = {d[0], d[1], d[2]};
    if (angle(dir, at.data()) <= radius && world.sim.nav().blocked(node)) ++count;
  }
  return count;
}

}  // namespace

TEST_CASE("level dry ground takes a hut, and a tribe's first one is free") {
  World world;
  CHECK(site(world, kHome, 0) == HutSite::kOk);
  CHECK(world.sim.huts().cost(HutKind::kDwelling, 0) == 0);
  // A negative tribe asks about the ground alone.
  CHECK(site(world, kHome, -1) == HutSite::kOk);
  CHECK(world.sim.huts().cost(HutKind::kDwelling, -1) == 0);
}

TEST_CASE("a site is refused for water, a slope, or no grid at all") {
  inkulous::Simulation empty;
  CHECK(empty.huts().check_site(0.0, 0.0, 1.0, HutKind::kDwelling, 0) == HutSite::kNoGrid);

  World sea(12, [](const Vec3& d) { return d[2] > 0.5 ? 0.0 : static_cast<double>(kLand); });
  CHECK(site(sea, kHome, 0) == HutSite::kWater);

  World hill;
  hill.sim.terrain().sculpt(kHome.data(), 0.15, 0.03);
  const Vec3 slope = step_towards(kHome, {1.0, 0.0, 0.0}, 0.07);
  CHECK(site(hill, slope, 0) == HutSite::kUneven);
}

TEST_CASE("a hut blocks its footprint, and nothing else may be built touching it") {
  World world;
  REQUIRE(build(world, kHome, 0) == 0);
  CHECK(world.sim.huts().count() == 1);
  CHECK(world.sim.huts().tribe(0) == 0);
  CHECK(world.sim.huts().kind(0) == static_cast<std::int32_t>(HutKind::kDwelling));
  CHECK(blocked_near(world, kHome, 0.2) > 1);

  CHECK(site(world, kHome, 0) == HutSite::kOccupied);
  // The footprint is a node and its neighbours, and the lane beside it is one
  // more node wide: on this planet that is about 0.5 radians in all.
  const Vec3 touching = step_towards(kHome, {1.0, 0.0, 0.0}, 0.3);
  CHECK(site(world, touching, -1) == HutSite::kOccupied);
  const Vec3 clear = step_towards(kHome, {1.0, 0.0, 0.0}, 1.0);
  CHECK(site(world, clear, -1) == HutSite::kOk);

  // And a refused place builds nothing.
  CHECK(build(world, kHome, 0) == -1);
  CHECK(world.sim.huts().count() == 1);

  world.sim.huts().clear();
  CHECK(world.sim.huts().count() == 0);
}

TEST_CASE("the second hut costs wood, and is refused until the tribe has it") {
  World world;
  REQUIRE(build(world, kHome, 0) == 0);
  const Vec3 second = step_towards(kHome, {1.0, 0.0, 0.0}, 1.0);

  CHECK(world.sim.huts().cost(HutKind::kDwelling, 0) == inkulous::kHutWoodCost);
  CHECK(site(world, second, 0) == HutSite::kNoWood);
  CHECK(build(world, second, 0) == -1);

  world.sim.stores().set_wood(0, inkulous::kHutWoodCost + 2);
  CHECK(site(world, second, 0) == HutSite::kOk);
  REQUIRE(build(world, second, 0) == 1);
  CHECK(world.sim.stores().wood(0) == 2);

  // An unclaimed hut is free for anyone and costs nobody.
  const Vec3 third = step_towards(kHome, {-1.0, 0.0, 0.0}, 1.0);
  REQUIRE(build(world, third, -1) == 2);
  CHECK(world.sim.huts().tribe(2) == -1);
  CHECK(world.sim.stores().wood(0) == 2);
}

TEST_CASE("a training hut is never free, and takes one at a time") {
  World world;
  CHECK(world.sim.huts().cost(HutKind::kTraining, 0) == inkulous::kTrainingHutWoodCost);
  CHECK(site(world, kHome, 0, HutKind::kTraining) == HutSite::kNoWood);
  world.sim.stores().set_wood(0, inkulous::kTrainingHutWoodCost);
  REQUIRE(build(world, kHome, 0, HutKind::kTraining) == 0);
  CHECK(world.sim.huts().kind(0) == static_cast<std::int32_t>(HutKind::kTraining));
  CHECK(inkulous::HutSet::capacity(HutKind::kTraining) == inkulous::kTrainingCapacity);
  CHECK(inkulous::HutSet::capacity(HutKind::kDwelling) == inkulous::kHutCapacity);
}

TEST_CASE("braves walk into a hut, up to its capacity, and come back out") {
  World world;
  REQUIRE(build(world, kHome, 0) == 0);
  const Vec3 door = step_towards(kHome, {0.0, 1.0, 0.0}, 0.15);
  auto& followers = world.sim.followers();
  for (int i = 0; i < 5; ++i) {
    const std::int32_t id = followers.spawn(door[0], door[1], door[2], 0);
    REQUIRE(id >= 0);
    followers.set_selected(id, true);
  }

  // Five want in; the hut holds three.
  CHECK(world.sim.huts().order_enter_selected(0) == inkulous::kHutCapacity);
  world.run_until(30.0, [&] { return world.sim.huts().occupants(0) == inkulous::kHutCapacity; });
  CHECK(world.sim.huts().occupants(0) == inkulous::kHutCapacity);
  CHECK(world.sim.huts().housed() == inkulous::kHutCapacity);
  // Those inside are out of the follower set.
  CHECK(followers.count() == 2);

  CHECK(world.sim.huts().eject(0) == inkulous::kHutCapacity);
  CHECK(world.sim.huts().occupants(0) == 0);
  CHECK(followers.count() == 5);
}

TEST_CASE("people inside a hut breed") {
  World world;
  REQUIRE(build(world, kHome, 0) == 0);
  const Vec3 door = step_towards(kHome, {0.0, 1.0, 0.0}, 0.12);
  auto& followers = world.sim.followers();
  for (int i = 0; i < 3; ++i) {
    const std::int32_t id = followers.spawn(door[0], door[1], door[2], 0);
    followers.set_selected(id, true);
  }
  world.sim.huts().order_enter_selected(0);
  world.run_until(20.0, [&] { return world.sim.huts().occupants(0) == 3; });
  REQUIRE(world.sim.huts().occupants(0) == 3);

  // One birth per kHutBreedSeconds of occupant time: three inside makes one in 10s.
  const std::int32_t population = world.sim.shamans().population(0);
  world.run(inkulous::kHutBreedSeconds / 3.0 + 2.0);
  CHECK(world.sim.shamans().population(0) > population);
}

TEST_CASE("bad hut ids answer with -1") {
  World world;
  CHECK(world.sim.huts().occupants(0) == -1);
  CHECK(world.sim.huts().tribe(-1) == -1);
  CHECK(world.sim.huts().kind(7) == -1);
  CHECK(world.sim.huts().eject(3) == 0);
}
