// Shamans, mana and spells: one cast path for the player and the AI alike.

#include <vector>

#include <doctest/doctest.h>

#include "support.hpp"

using namespace testing_support;
using inkulous::Spell;
using inkulous::SpellResult;
using inkulous::SpellTarget;

namespace {

const Vec3 kHome = {0.0, 0.0, 1.0};

SpellTarget at(const Vec3& point) {
  SpellTarget target;
  for (int c = 0; c < 3; ++c) target.at[c] = point[static_cast<std::size_t>(c)];
  return target;
}

// A world with tribe 0's shaman at home and mana to spend.
struct Shaman {
  World world;
  std::int32_t id = -1;
  Shaman() {
    id = world.sim.shamans().spawn(kHome[0], kHome[1], kHome[2], 0);
    world.sim.shamans().set_mana(0, 1000.0);
  }
};

}  // namespace

TEST_CASE("a tribe gets one shaman, flagged, and nobody else does") {
  World world;
  auto& shamans = world.sim.shamans();
  const std::int32_t id = shamans.spawn(kHome[0], kHome[1], kHome[2], 0);
  REQUIRE(id >= 0);
  CHECK(world.sim.followers().is_shaman(id));
  CHECK(world.sim.followers().shaman(0) == id);
  CHECK(world.sim.followers().shaman(1) == -1);
  CHECK(shamans.spawn(kHome[0], kHome[1], kHome[2], 0) == -1);
  CHECK(shamans.spawn(1.0, 0.0, 0.0, 1) >= 0);
}

TEST_CASE("mana fills with population, and stops at the ceiling") {
  World world;
  auto& shamans = world.sim.shamans();
  shamans.spawn(kHome[0], kHome[1], kHome[2], 0);
  for (int i = 0; i < 4; ++i) world.sim.followers().spawn(kHome[0], kHome[1], kHome[2], 0);

  CHECK(shamans.mana(0) == 0.0);
  world.run(1.0);
  // Five people for a second.
  CHECK(within(shamans.mana(0), 5.0 * inkulous::kManaPerPersonSecond, 0.05));
  CHECK(shamans.income(0) == doctest::Approx(5.0 * inkulous::kManaPerPersonSecond));

  shamans.set_mana(0, 5000.0);
  CHECK(shamans.mana(0) == inkulous::kMaxMana);
  shamans.set_mana(0, -3.0);
  CHECK(shamans.mana(0) == 0.0);
  CHECK(shamans.mana(99) == 0.0);
}

TEST_CASE("a spell is checked before it is cast, and a refused cast changes nothing") {
  World world;
  auto& shamans = world.sim.shamans();
  const Vec3 near_by = step_towards(kHome, {1.0, 0.0, 0.0}, 0.1);
  // Nobody to cast.
  CHECK(shamans.check(Spell::kBlast, 0, at(near_by)) == SpellResult::kNoShaman);

  shamans.spawn(kHome[0], kHome[1], kHome[2], 0);
  CHECK(shamans.check(Spell::kBlast, 0, at(near_by)) == SpellResult::kNoMana);
  CHECK(shamans.cast(Spell::kBlast, 0, at(near_by)) == SpellResult::kNoMana);
  CHECK(shamans.casting(0) == -1);
  CHECK(world.sim.terrain().dirty().empty());

  shamans.set_mana(0, 1000.0);
  const Vec3 too_far = step_towards(kHome, {1.0, 0.0, 0.0}, 1.0);
  CHECK(shamans.check(Spell::kBlast, 0, at(too_far)) == SpellResult::kOutOfRange);
  CHECK(shamans.check(static_cast<Spell>(99), 0, at(near_by)) == SpellResult::kUnknownSpell);
  CHECK(shamans.check(Spell::kBlast, 0, at(near_by)) == SpellResult::kOk);
}

TEST_CASE("a Blast takes its cast time to land, then raises the ground and spends the mana") {
  Shaman fixture;
  auto& world = fixture.world;
  auto& shamans = world.sim.shamans();
  const Vec3 target = step_towards(kHome, {1.0, 0.0, 0.0}, 0.1);
  const double before = world.sim.terrain().height_at(target.data());

  REQUIRE(shamans.cast(Spell::kBlast, 0, at(target)) == SpellResult::kOk);
  CHECK(shamans.casting(0) == static_cast<std::int32_t>(Spell::kBlast));
  CHECK(world.sim.followers().casting(fixture.id));
  CHECK(shamans.cast_progress(0) == 0.0);
  // Nothing yet: not paid, not raised.
  CHECK(world.sim.terrain().height_at(target.data()) == before);

  world.run_until(5.0, [&] { return shamans.casting(0) == -1; });
  CHECK(shamans.casting(0) == -1);
  CHECK(world.sim.terrain().height_at(target.data()) > before);
  CHECK(shamans.mana(0) < 1000.0 - inkulous::spell_rules(Spell::kBlast).cost + 20.0);
  CHECK(shamans.last_end(0).result == SpellResult::kOk);
  CHECK(shamans.last_end(0).spell == Spell::kBlast);
  CHECK(shamans.last_end(0).count == 1);
  CHECK_FALSE(world.sim.terrain().dirty().empty());

  // A second straight after is refused until the cooldown is over.
  CHECK(shamans.cooldown(0, Spell::kBlast) > 0.0);
  CHECK(shamans.check(Spell::kBlast, 0, at(target)) == SpellResult::kCooling);
  world.run(inkulous::spell_rules(Spell::kBlast).cooldown_seconds + 0.5);
  CHECK(shamans.cooldown(0, Spell::kBlast) == 0.0);
}

TEST_CASE("a move order cancels a cast with nothing spent") {
  Shaman fixture;
  auto& world = fixture.world;
  auto& shamans = world.sim.shamans();
  const Vec3 target = step_towards(kHome, {1.0, 0.0, 0.0}, 0.1);
  REQUIRE(shamans.cast(Spell::kBlast, 0, at(target)) == SpellResult::kOk);

  world.sim.followers().set_selected(fixture.id, true);
  const Vec3 away = step_towards(kHome, {0.0, 1.0, 0.0}, 0.2);
  world.sim.followers().order_move_selected(away[0], away[1], away[2]);
  world.run(0.2);

  CHECK(shamans.casting(0) == -1);
  CHECK(shamans.last_end(0).result == SpellResult::kCancelled);
  CHECK(shamans.mana(0) > 990.0);
  CHECK(world.sim.terrain().dirty().empty());
}

TEST_CASE("a cast that runs out of mana before it lands is refused then") {
  Shaman fixture;
  auto& world = fixture.world;
  auto& shamans = world.sim.shamans();
  const Vec3 target = step_towards(kHome, {1.0, 0.0, 0.0}, 0.1);
  shamans.set_mana(0, inkulous::spell_rules(Spell::kBlast).cost);
  REQUIRE(shamans.cast(Spell::kBlast, 0, at(target)) == SpellResult::kOk);
  shamans.set_mana(0, 0.0);
  world.run(3.0);
  CHECK(shamans.last_end(0).result == SpellResult::kNoMana);
  CHECK(world.sim.terrain().dirty().empty());
  CHECK(shamans.cooldown(0, Spell::kBlast) == 0.0);
}

TEST_CASE("Swamp floods a disc and Flatten levels one") {
  Shaman fixture;
  auto& world = fixture.world;
  auto& shamans = world.sim.shamans();
  const Vec3 target = step_towards(kHome, {1.0, 0.0, 0.0}, 0.1);

  REQUIRE(shamans.cast(Spell::kSwamp, 0, at(target)) == SpellResult::kOk);
  world.run_until(5.0, [&] { return shamans.casting(0) == -1; });
  CHECK(world.sim.terrain().height_at(target.data()) == 0.0);
  // Flatten on water has nothing to level.
  CHECK(shamans.check(Spell::kFlatten, 0, at(target)) == SpellResult::kWet);
}

TEST_CASE("a Land Bridge opens a route across a moat, and not across dry land") {
  // A moat of sea ringing the pole: the cap inside is cut off from the rest.
  World world(16, [](const Vec3& d) {
    const double polar = std::acos(d[1]);
    return (polar > 0.35 && polar < 0.5) ? 0.0 : static_cast<double>(kLand);
  });
  auto& shamans = world.sim.shamans();
  const Vec3 pole = {0.0, 1.0, 0.0};
  const Vec3 bank = step_towards(pole, {0.0, 0.0, 1.0}, 0.55);
  const Vec3 cap = step_towards(pole, {0.0, 0.0, 1.0}, 0.3);
  shamans.spawn(bank[0], bank[1], bank[2], 0);
  shamans.set_mana(0, 1000.0);

  auto& nav = world.sim.nav();
  std::vector<std::int32_t> route;
  const std::int32_t from = nav.nearest_walkable_node(bank[0], bank[1], bank[2]);
  const std::int32_t to = nav.nearest_walkable_node(cap[0], cap[1], cap[2]);
  REQUIRE_FALSE(nav.find_path(from, to, route));

  // Dry land at both ends of a bridge is nothing to bridge.
  const Vec3 dry = step_towards(bank, {0.0, -1.0, 0.0}, 0.1);
  CHECK(shamans.check(Spell::kLandBridge, 0, at(dry)) == SpellResult::kDry);

  REQUIRE(shamans.check(Spell::kLandBridge, 0, at(cap)) == SpellResult::kOk);
  REQUIRE(shamans.cast(Spell::kLandBridge, 0, at(cap)) == SpellResult::kOk);
  world.run_until(10.0, [&] { return shamans.casting(0) == -1; });
  CHECK(shamans.last_end(0).result == SpellResult::kOk);
  CHECK(shamans.stamp_count() > 0);
  CHECK(shamans.mana(0) < 1000.0 - inkulous::spell_rules(Spell::kLandBridge).cost + 20.0);

  // The graph was not rebuilt, and a route now crosses.
  CHECK(nav.find_path(from, to, route));
}

TEST_CASE("the match ends when a shaman is killed and at most one stands") {
  World world;
  auto& shamans = world.sim.shamans();
  const std::int32_t red = shamans.spawn(kHome[0], kHome[1], kHome[2], 1);
  const Vec3 far_away = step_towards(kHome, {1.0, 0.0, 0.0}, 1.2);
  const std::int32_t blue = shamans.spawn(far_away[0], far_away[1], far_away[2], 0);
  REQUIRE(red >= 0);
  REQUIRE(blue >= 0);
  CHECK_FALSE(shamans.match_over());
  CHECK(shamans.winner() == -1);

  // A warrior of blue's by red's shaman.
  const std::int32_t warrior = world.sim.followers().spawn(kHome[0], kHome[1], kHome[2], 0);
  world.sim.followers().set_role(warrior, inkulous::Role::kWarrior);
  world.run_until(15.0, [&] { return shamans.match_over(); });
  CHECK(shamans.match_over());
  CHECK(shamans.winner() == 0);
  CHECK(world.sim.followers().fallen(1));
  CHECK_FALSE(world.sim.followers().fallen(0));
}
