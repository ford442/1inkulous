// What scenarios build worlds from: generated terrain, trees planted back
// exactly, spells held back until a tribe has grown, AI personalities, and a
// world cleared down to its ground.

#include <doctest/doctest.h>

#include <cmath>
#include <limits>

#include "support.hpp"

using namespace testing_support;
using inkulous::AiAction;
using inkulous::AiPersonality;
using inkulous::HutKind;
using inkulous::Spell;
using inkulous::SpellResult;
using inkulous::SpellTarget;
using inkulous::WorldGenParams;

namespace {

const Vec3 kHome = {0.0, 0.0, 1.0};

std::vector<float> heights_of(World& world) {
  const auto& nav = world.sim.nav();
  std::vector<float> out(static_cast<std::size_t>(nav.node_count()));
  for (std::int32_t node = 0; node < nav.node_count(); ++node) {
    out[static_cast<std::size_t>(node)] = nav.height(node);
  }
  return out;
}

std::int32_t dry_nodes(World& world) {
  std::int32_t dry = 0;
  for (const float h : heights_of(world)) {
    dry += h > 0.0f ? 1 : 0;
  }
  return dry;
}

SpellTarget at(const Vec3& where) {
  SpellTarget target;
  target.at[0] = where[0];
  target.at[1] = where[1];
  target.at[2] = where[2];
  return target;
}

}  // namespace

TEST_CASE("a world is a seed and parameters: the same ones give the same ground") {
  WorldGenParams params;
  params.seed = 42;
  World first(24);
  World second(24);
  REQUIRE(first.sim.terrain().generate(params) > 0);
  REQUIRE(second.sim.terrain().generate(params) > 0);
  CHECK(heights_of(first) == heights_of(second));

  World other(24);
  params.seed = 43;
  other.sim.terrain().generate(params);
  CHECK(heights_of(other) != heights_of(first));
}

TEST_CASE("the sea is put wherever it leaves the land asked for") {
  for (const double land : {0.25, 0.4, 0.6}) {
    World world(24);
    WorldGenParams params;
    params.seed = 7;
    params.land = land;
    const std::int32_t reported = world.sim.terrain().generate(params);
    const std::int32_t nodes = world.sim.nav().node_count();
    CHECK(reported == dry_nodes(world));
    CHECK(std::abs(reported - static_cast<std::int32_t>(std::lround(land * nodes))) <= 1);
  }
  World drowned(12);
  WorldGenParams none;
  none.land = 0.0;
  CHECK(drowned.sim.terrain().generate(none) == 0);
  World continent(12);
  WorldGenParams all;
  all.land = 1.0;
  CHECK(continent.sim.terrain().generate(all) == continent.sim.nav().node_count());
}

TEST_CASE("water is exactly sea level and land stays under the ceiling") {
  World world(24);
  WorldGenParams params;
  params.seed = 3;
  params.ridges = 1.0;
  params.peak = 1.0;
  params.relief = 0.5;
  world.sim.terrain().generate(params);
  bool any_water = false;
  for (const float h : heights_of(world)) {
    CHECK(h >= 0.0f);
    CHECK(h <= static_cast<float>(kMaxHeight));
    any_water = any_water || h == 0.0f;
  }
  CHECK(any_water);
}

TEST_CASE("generating marks the whole field dirty and draws nothing from the match") {
  World world(12);
  world.sim.seed_match(99);
  const std::uint32_t before = world.sim.random().state();
  world.sim.terrain().clear_dirty();
  world.sim.terrain().generate(WorldGenParams{});
  CHECK(world.sim.random().state() == before);
  CHECK(world.sim.terrain().dirty().first == 0);
  CHECK(world.sim.terrain().dirty().last == world.sim.nav().node_count() - 1);
}

TEST_CASE("nonsense parameters are clamped rather than trusted") {
  WorldGenParams wild;
  wild.land = 3.0;
  wild.octaves = 99;
  wild.frequency = std::numeric_limits<double>::quiet_NaN();
  wild.continents = -4;
  wild.smoothing = 1000;
  const WorldGenParams safe = inkulous::sanitized(wild);
  CHECK(safe.land == 1.0);
  CHECK(safe.octaves == 8);
  CHECK(safe.frequency == WorldGenParams{}.frequency);
  CHECK(safe.continents == 0);
  CHECK(safe.smoothing == 8);
  World world(12);
  CHECK(world.sim.terrain().generate(wild) == world.sim.nav().node_count());
}

TEST_CASE("a scattered tree planted back with its size and lean is the same tree") {
  World first;
  first.sim.seed_match(5);
  REQUIRE(first.sim.trees().spawn(20, first.sim.random()) > 0);
  World second;
  auto& trees = first.sim.trees();
  for (std::int32_t id = 0; id < trees.count(); ++id) {
    const double* d = trees.direction(id);
    REQUIRE(second.sim.trees().plant(d[0], d[1], d[2], trees.size(id), trees.turn(id)) == id);
  }
  REQUIRE(second.sim.trees().count() == trees.count());
  const float* a = trees.instances();
  const float* b = second.sim.trees().instances();
  for (std::int32_t i = 0; i < trees.count() * inkulous::kTreeInstanceFloats; ++i) {
    CHECK(a[i] == b[i]);
  }
  CHECK(second.sim.trees().size(-1) == 0.0);
  // A plain plant is the tree it always was: full size, no turn.
  World plain;
  const std::int32_t id = plain.sim.trees().plant(kHome[0], kHome[1], kHome[2]);
  CHECK(plain.sim.trees().size(id) == 1.0);
  CHECK(plain.sim.trees().turn(id) == 0.0);
}

TEST_CASE("a spell held back is refused until the tribe has grown to it") {
  World world;
  world.sim.shamans().spawn(kHome[0], kHome[1], kHome[2], 0);
  world.sim.shamans().set_mana(0, inkulous::kMaxMana);
  const Vec3 target = step_towards(kHome, {1.0, 0.0, 0.0}, 0.1);
  REQUIRE(world.sim.shamans().check(Spell::kBlast, 0, at(target)) == SpellResult::kOk);

  world.sim.shamans().set_unlock(0, Spell::kBlast, inkulous::kSpellNever);
  CHECK(world.sim.shamans().check(Spell::kBlast, 0, at(target)) == SpellResult::kLocked);
  CHECK(world.sim.shamans().cast(Spell::kBlast, 0, at(target)) == SpellResult::kLocked);
  CHECK(world.sim.shamans().casting(0) < 0);
  // Other tribes and other spells are untouched.
  CHECK(world.sim.shamans().unlock_at(1, Spell::kBlast) == 0);
  CHECK(world.sim.shamans().check(Spell::kSwamp, 0, at(target)) == SpellResult::kOk);

  world.sim.shamans().set_unlock(0, Spell::kBlast, 4);
  world.run(1.0);
  CHECK(world.sim.shamans().unlock_at(0, Spell::kBlast) == 4);
  for (int i = 0; i < 3; ++i) world.sim.followers().spawn(kHome[0], kHome[1], kHome[2], 0);
  world.run(0.1);
  CHECK(world.sim.shamans().unlock_at(0, Spell::kBlast) == 0);
  CHECK(world.sim.shamans().check(Spell::kBlast, 0, at(target)) == SpellResult::kOk);

  world.sim.shamans().set_unlock(0, Spell::kBlast, inkulous::kSpellNever);
  world.sim.clear_world();
  CHECK(world.sim.shamans().unlock_at(0, Spell::kBlast) == 0);
  CHECK(world.sim.shamans().unlock_at(9, Spell::kBlast) == inkulous::kSpellNever);
}

TEST_CASE("a personality is kept across enable and clamped to sense") {
  World world;
  AiPersonality slow;
  slow.think_seconds = 5.0;
  slow.hut_cap = 1;
  slow.muster = 0;
  REQUIRE(world.sim.ai().configure(1, slow));
  CHECK_FALSE(world.sim.ai().configure(7, slow));
  CHECK(world.sim.ai().personality(1).muster == 1);
  world.sim.shamans().spawn(kHome[0], kHome[1], kHome[2], 1);
  REQUIRE(world.sim.ai().enable(1));
  CHECK(world.sim.ai().personality(1).think_seconds == 5.0);
  world.run(9.9);
  CHECK(world.sim.ai().thinks(1) == 1);
  world.sim.clear_world();
  CHECK(world.sim.ai().personality(1).think_seconds == inkulous::kAiThinkSeconds);
}

TEST_CASE("a mustering AI holds its warriors at home until there are enough") {
  World world;
  world.sim.shamans().spawn(kHome[0], kHome[1], kHome[2], 1);
  const Vec3 enemy = step_towards(kHome, {1.0, 0.0, 0.0}, 1.0);
  world.sim.shamans().spawn(enemy[0], enemy[1], enemy[2], 0);
  AiPersonality patient;
  patient.muster = 3;
  patient.hut_cap = 0;
  REQUIRE(world.sim.ai().configure(1, patient));
  const Vec3 yard = step_towards(kHome, {0.0, 1.0, 0.0}, 0.05);
  auto recruit = [&] {
    const std::int32_t id = world.sim.followers().spawn(yard[0], yard[1], yard[2], 1);
    REQUIRE(world.sim.followers().set_role(id, inkulous::Role::kWarrior));
  };
  recruit();
  recruit();
  REQUIRE(world.sim.ai().enable(1));
  world.run(10.0);
  CHECK(world.sim.ai().last_action(1) != AiAction::kAttack);
  for (std::int32_t f = 0; f < world.sim.followers().count(); ++f) {
    CHECK_FALSE(world.sim.followers().is_walking(f));
  }
  recruit();
  world.run(inkulous::kAiThinkSeconds + 0.1);
  std::int32_t marching = 0;
  for (std::int32_t f = 0; f < world.sim.followers().count(); ++f) {
    marching += world.sim.followers().is_walking(f) ? 1 : 0;
  }
  CHECK(marching == 3);
}

TEST_CASE("a settling AI keeps braves in its dwelling to breed") {
  World world;
  world.sim.shamans().spawn(kHome[0], kHome[1], kHome[2], 1);
  const Vec3 pad = step_towards(kHome, {0.0, 1.0, 0.0}, 0.2);
  const std::int32_t hut =
      world.sim.huts().place(pad[0], pad[1], pad[2], 1.0, 0.0, 0.0, 1, HutKind::kDwelling);
  REQUIRE(hut >= 0);
  for (int i = 0; i < 5; ++i) world.sim.followers().spawn(kHome[0], kHome[1], kHome[2], 1);
  AiPersonality settler;
  settler.settle = 2;
  settler.hut_cap = 1;
  REQUIRE(world.sim.ai().configure(1, settler));
  REQUIRE(world.sim.ai().enable(1));
  world.run_until(30.0, [&] { return world.sim.huts().occupants(hut) >= 2; });
  CHECK(world.sim.huts().occupants(hut) == 2);
  CHECK(world.sim.ai().actions(1) >= 1);
}

TEST_CASE("clearing a world leaves the ground and takes everything else") {
  World world;
  world.sim.terrain().sculpt(kHome.data(), 0.2, 0.01);
  const auto ground = heights_of(world);
  world.sim.shamans().spawn(kHome[0], kHome[1], kHome[2], 0);
  const Vec3 pad = step_towards(kHome, {1.0, 0.0, 0.0}, 0.5);
  REQUIRE(world.sim.huts().place(pad[0], pad[1], pad[2], 0.0, 1.0, 0.0, 0, HutKind::kDwelling) >=
          0);
  world.sim.trees().plant(-kHome[0], -kHome[1], -kHome[2]);
  world.sim.stores().set_wood(0, 30);
  world.sim.shamans().set_mana(0, 300);
  world.sim.ai().enable(0);
  world.sim.clear_world();
  CHECK(world.sim.followers().count() == 0);
  CHECK(world.sim.huts().count() == 0);
  CHECK(world.sim.trees().count() == 0);
  CHECK(world.sim.stores().wood(0) == 0);
  CHECK(world.sim.shamans().mana(0) == 0.0);
  CHECK_FALSE(world.sim.ai().enabled(0));
  CHECK(heights_of(world) == ground);
  // The footprint is given back: the ground under the old hut takes another.
  CHECK(world.sim.huts().place(pad[0], pad[1], pad[2], 0.0, 1.0, 0.0, 0, HutKind::kDwelling) >= 0);
}
