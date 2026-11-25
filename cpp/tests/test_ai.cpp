// The core's tribe AI: thinks every couple of seconds, does at most one thing.

#include <doctest/doctest.h>

#include "support.hpp"

using namespace testing_support;
using inkulous::AiAction;

namespace {

const Vec3 kHome = {0.0, 0.0, 1.0};

// Tribe 1: a shaman and a few braves, with trees nearby to cut.
void settle_tribe(World& world, std::int32_t braves) {
  world.sim.shamans().spawn(kHome[0], kHome[1], kHome[2], 1);
  for (std::int32_t i = 0; i < braves; ++i) {
    world.sim.followers().spawn(kHome[0], kHome[1], kHome[2], 1);
  }
  for (const Vec3& direction :
       {Vec3{0.2, 0.0, 1.0}, Vec3{-0.2, 0.0, 1.0}, Vec3{0.0, 0.2, 1.0}, Vec3{0.0, -0.2, 1.0}}) {
    const Vec3 at = normalized(direction);
    world.sim.trees().plant(at[0], at[1], at[2]);
  }
}

}  // namespace

TEST_CASE("nothing plays a tribe until it is handed one") {
  World world;
  settle_tribe(world, 4);
  CHECK_FALSE(world.sim.ai().enabled(1));
  world.run(10.0);
  CHECK(world.sim.ai().thinks(1) == 0);
  CHECK(world.sim.huts().count() == 0);
}

TEST_CASE("a tribe with no shaman and no hut cannot be handed over") {
  World world;
  CHECK_FALSE(world.sim.ai().enable(1));
  CHECK_FALSE(world.sim.ai().enable(99));
  CHECK_FALSE(world.sim.ai().enabled(1));
}

TEST_CASE("it thinks every few seconds and does at most one thing each time") {
  World world;
  settle_tribe(world, 5);
  REQUIRE(world.sim.ai().enable(1));
  CHECK(world.sim.ai().enabled(1));

  world.run(inkulous::kAiThinkSeconds * 4.0 + 0.5);
  const std::int32_t thinks = world.sim.ai().thinks(1);
  CHECK(thinks >= 3);
  CHECK(thinks <= 5);
  CHECK(world.sim.ai().actions(1) <= thinks);
  CHECK(world.sim.ai().actions(1) >= 1);
  const auto last = static_cast<std::int32_t>(world.sim.ai().last_action(1));
  CHECK(last >= static_cast<std::int32_t>(AiAction::kWait));
  CHECK(last <= static_cast<std::int32_t>(AiAction::kAttack));
}

TEST_CASE("it builds its first hut and fells trees for wood") {
  World world;
  settle_tribe(world, 6);
  REQUIRE(world.sim.ai().enable(1));
  world.run_until(60.0,
                  [&] { return world.sim.huts().count() >= 1 && world.sim.stores().wood(1) > 0; });
  CHECK(world.sim.huts().count() >= 1);
  CHECK(world.sim.huts().tribe(0) == 1);
}

TEST_CASE("handing a tribe back stops its thinking") {
  World world;
  settle_tribe(world, 4);
  REQUIRE(world.sim.ai().enable(1));
  world.run(5.0);
  const std::int32_t thinks = world.sim.ai().thinks(1);
  world.sim.ai().disable(1);
  CHECK_FALSE(world.sim.ai().enabled(1));
  world.run(10.0);
  CHECK(world.sim.ai().thinks(1) == thinks);
}
