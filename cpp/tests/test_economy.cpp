// Wood and trees: scattered once, chopped by braves, paid out to the tribe.

#include <vector>

#include <doctest/doctest.h>

#include "support.hpp"

using namespace testing_support;
using inkulous::HutKind;
using inkulous::Role;

namespace {

const Vec3 kHome = {0.0, 0.0, 1.0};

std::vector<Vec3> forest(World& world) {
  std::vector<Vec3> out;
  for (std::int32_t id = 0; id < world.sim.trees().count(); ++id) {
    const double* d = world.sim.trees().direction(id);
    out.push_back({d[0], d[1], d[2]});
  }
  return out;
}

}  // namespace

TEST_CASE("wood is a number per tribe, clamped at zero") {
  inkulous::Stockpile stores;
  CHECK(stores.wood(0) == 0);
  stores.set_wood(1, 12);
  CHECK(stores.wood(1) == 12);
  stores.set_wood(1, -3);
  CHECK(stores.wood(1) == 0);

  stores.add_wood(2, 7);
  CHECK(stores.spend_wood(2, 5));
  CHECK(stores.wood(2) == 2);
  // Too little: refused, and nothing taken.
  CHECK_FALSE(stores.spend_wood(2, 5));
  CHECK(stores.wood(2) == 2);

  // A tribe that does not exist has none and cannot be charged.
  stores.add_wood(99, 5);
  CHECK(stores.wood(99) == 0);
  CHECK_FALSE(stores.spend_wood(-1, 1));
  CHECK(stores.spend_wood(-1, 0));
}

TEST_CASE("a forest is scattered from a seed, on dry land only") {
  World world(12, [](const Vec3& d) { return d[1] >= 0.0 ? static_cast<double>(kLand) : 0.0; });
  world.sim.seed_match(7);
  const std::int32_t planted = world.sim.trees().spawn(40, world.sim.random());
  REQUIRE(planted > 0);
  CHECK(planted <= 40);
  CHECK(world.sim.trees().count() == planted);
  for (const Vec3& tree : forest(world)) {
    CHECK(tree[1] >= -0.15);  // the shoreline's node spacing, no further
  }

  const auto first = forest(world);
  world.sim.seed_match(7);
  world.sim.trees().spawn(40, world.sim.random());
  CHECK(forest(world) == first);
  world.sim.seed_match(8);
  world.sim.trees().spawn(40, world.sim.random());
  CHECK(forest(world) != first);

  world.sim.trees().clear();
  CHECK(world.sim.trees().count() == 0);
}

TEST_CASE("a tree is planted where asked, once") {
  World world;
  const std::int32_t id = world.sim.trees().plant(kHome[0], kHome[1], kHome[2]);
  REQUIRE(id == 0);
  CHECK(world.sim.trees().progress(id) == 0.0);
  CHECK(world.sim.trees().plant(kHome[0], kHome[1], kHome[2]) == -1);
  CHECK(world.sim.trees().progress(5) == -1.0);
}

TEST_CASE("a brave chops a tree down and its tribe gets the wood") {
  World world;
  const Vec3 tree_at = step_towards(kHome, {1.0, 0.0, 0.0}, 0.3);
  REQUIRE(world.sim.trees().plant(tree_at[0], tree_at[1], tree_at[2]) == 0);

  auto& followers = world.sim.followers();
  const std::int32_t brave = followers.spawn(kHome[0], kHome[1], kHome[2], 0);
  const std::int32_t warrior = followers.spawn(kHome[0], kHome[1], kHome[2], 0);
  followers.set_role(warrior, Role::kWarrior);
  followers.set_selected(brave, true);
  followers.set_selected(warrior, true);

  // Only the brave goes.
  CHECK(world.sim.trees().order_chop_selected(0) == 1);
  CHECK(followers.tree(brave) == 0);
  CHECK(followers.tree(warrior) == -1);
  CHECK(world.sim.trees().order_chop_selected(5) == 0);

  world.run_until(40.0, [&] { return world.sim.trees().count() == 0; });
  CHECK(world.sim.trees().count() == 0);
  CHECK(world.sim.stores().wood(0) == inkulous::kWoodPerTree);
  // The order is over.
  CHECK(followers.tree(brave) == -1);
}

TEST_CASE("more choppers fell a tree faster, but only a few fit") {
  auto seconds_with = [](int choppers) {
    World world;
    const Vec3 tree_at = step_towards(kHome, {1.0, 0.0, 0.0}, 0.2);
    world.sim.trees().plant(tree_at[0], tree_at[1], tree_at[2]);
    std::int32_t sent = 0;
    for (int i = 0; i < choppers; ++i) {
      const std::int32_t id = world.sim.followers().spawn(tree_at[0], tree_at[1], tree_at[2], 0);
      world.sim.followers().set_selected(id, true);
    }
    sent = world.sim.trees().order_chop_selected(0);
    CHECK(sent == std::min(choppers, inkulous::kChoppersPerTree));
    return world.run_until(60.0, [&] { return world.sim.trees().count() == 0; });
  };
  const double one = seconds_with(1);
  const double three = seconds_with(3);
  const double five = seconds_with(5);
  CHECK(three < one);
  CHECK(within(five, three, 0.2));
}

TEST_CASE("a warrior is trained from a brave and some wood") {
  World world;
  world.sim.stores().set_wood(0, inkulous::kTrainingHutWoodCost + inkulous::kWarriorWoodCost);
  REQUIRE(world.sim.huts().place(kHome[0], kHome[1], kHome[2], 0.0, 1.0, 0.0, 0,
                                 HutKind::kTraining) == 0);
  const Vec3 door = step_towards(kHome, {0.0, 1.0, 0.0}, 0.12);
  auto& followers = world.sim.followers();
  const std::int32_t brave = followers.spawn(door[0], door[1], door[2], 0);
  followers.set_selected(brave, true);

  CHECK(world.sim.huts().order_enter_selected(0) == 1);
  world.run_until(10.0, [&] { return world.sim.huts().occupants(0) == 1; });
  REQUIRE(world.sim.huts().occupants(0) == 1);
  CHECK(world.sim.stores().wood(0) == 0);
  CHECK(followers.count() == 0);

  world.run_until(inkulous::kTrainSeconds + 4.0, [&] { return followers.count() == 1; });
  REQUIRE(followers.count() == 1);
  CHECK(followers.role(0) == Role::kWarrior);
}

TEST_CASE("a training hut turns a brave away while there is no wood to train with") {
  World world;
  world.sim.stores().set_wood(0, inkulous::kTrainingHutWoodCost);
  REQUIRE(world.sim.huts().place(kHome[0], kHome[1], kHome[2], 0.0, 1.0, 0.0, 0,
                                 HutKind::kTraining) == 0);
  const Vec3 door = step_towards(kHome, {0.0, 1.0, 0.0}, 0.12);
  const std::int32_t brave = world.sim.followers().spawn(door[0], door[1], door[2], 0);
  world.sim.followers().set_selected(brave, true);
  CHECK(world.sim.huts().order_enter_selected(0) == 0);
}
