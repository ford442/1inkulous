// Terrain: the core owns the height per node and every edit goes through it.

#include <doctest/doctest.h>

#include "support.hpp"

using namespace testing_support;

namespace {
const Vec3 kCentre = {0.0, 0.0, 1.0};
}

TEST_CASE("height_at reads the ground under a direction") {
  World world;
  CHECK(world.sim.terrain().height_at(kCentre.data()) ==
        doctest::Approx(static_cast<double>(kLand)));
}

TEST_CASE("sculpt raises a disc, most at the centre, and widens the dirty range") {
  World world;
  auto& terrain = world.sim.terrain();
  REQUIRE(terrain.dirty().empty());

  const double before = terrain.height_at(kCentre.data());
  const auto range = terrain.sculpt(kCentre.data(), 0.3, 0.01);
  REQUIRE_FALSE(range.empty());
  CHECK(terrain.height_at(kCentre.data()) > before);
  CHECK(terrain.height_at(kCentre.data()) <= before + 0.01 + 1e-6);

  // Smoothly less to the rim: a point halfway out rose, but by less.
  const Vec3 halfway = step_towards(kCentre, {1.0, 0.0, 0.0}, 0.15);
  const double risen = terrain.height_at(halfway.data()) - before;
  CHECK(risen > 0.0);
  CHECK(risen < terrain.height_at(kCentre.data()) - before);

  // Outside the disc nothing moved.
  const Vec3 outside = step_towards(kCentre, {1.0, 0.0, 0.0}, 0.6);
  CHECK(terrain.height_at(outside.data()) == doctest::Approx(before));

  CHECK_FALSE(terrain.dirty().empty());
  CHECK(terrain.dirty().first <= range.first);
  CHECK(terrain.dirty().last >= range.last);
  terrain.clear_dirty();
  CHECK(terrain.dirty().empty());
}

TEST_CASE("edits stop at the ceiling and snap flooded ground to sea level") {
  World world;
  auto& terrain = world.sim.terrain();
  terrain.sculpt(kCentre.data(), 0.3, 1.0);
  CHECK(terrain.height_at(kCentre.data()) == doctest::Approx(kMaxHeight));

  terrain.sculpt(kCentre.data(), 0.3, -1.0);
  CHECK(terrain.height_at(kCentre.data()) == 0.0);
  // Water is not walkable.
  CHECK(world.sim.nav().nearest_node(kCentre[0], kCentre[1], kCentre[2]) >= 0);
  CHECK_FALSE(
      world.sim.nav().walkable(world.sim.nav().nearest_node(kCentre[0], kCentre[1], kCentre[2])));
}

TEST_CASE("a sculpt that changes nothing is reported as nothing") {
  World world;
  auto& terrain = world.sim.terrain();
  CHECK_FALSE(terrain.would_sculpt(kCentre.data(), 0.3, 0.0));
  CHECK(terrain.sculpt(kCentre.data(), 0.3, 0.0).empty());
  CHECK(terrain.dirty().empty());

  // Digging water deeper, or raising what is already at the ceiling.
  terrain.sculpt(kCentre.data(), 0.3, 1.0);
  terrain.clear_dirty();
  CHECK_FALSE(terrain.would_sculpt(kCentre.data(), 0.1, 0.01));
  CHECK(terrain.sculpt(kCentre.data(), 0.1, 0.01).empty());
}

TEST_CASE("flatten pulls a disc to a target height, at most `rate` at a time") {
  World world;
  auto& terrain = world.sim.terrain();
  terrain.sculpt(kCentre.data(), 0.2, 0.02);
  const double hill = terrain.height_at(kCentre.data());
  const double target = static_cast<double>(kLand);

  // A gentle rate only gets part of the way...
  const auto slow = terrain.flatten(kCentre.data(), 0.2, target, 0.005);
  REQUIRE_FALSE(slow.empty());
  const double partway = terrain.height_at(kCentre.data());
  CHECK(partway < hill);
  CHECK(partway > target);

  // ...and a big one lands on it exactly.
  terrain.flatten(kCentre.data(), 0.2, target, 1.0);
  CHECK(terrain.height_at(kCentre.data()) == doctest::Approx(target));
  CHECK_FALSE(terrain.would_flatten(kCentre.data(), 0.2, target, 1.0));
}

TEST_CASE("the nav graph and the terrain agree about the ground") {
  World world;
  auto& nav = world.sim.nav();
  const std::int32_t node = nav.nearest_walkable_node(kCentre[0], kCentre[1], kCentre[2]);
  world.sim.terrain().sculpt(nav.direction(node)[0] == 0.0f ? kCentre.data() : kCentre.data(), 0.2,
                             0.02);
  CHECK(nav.height(node) > kLand);
}
