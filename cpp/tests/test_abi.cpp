// The flat C ABI the TypeScript side calls, driven here exactly as it is there:
// scalars in and out, pointers into the module's memory for the bulk data. The
// module owns one world, so these cases run in order against it and each one
// leaves it clean.

#include <algorithm>
#include <cstring>
#include <vector>

#include <doctest/doctest.h>

#include "1inkulous/core_abi.h"
#include "support.hpp"

using namespace testing_support;

namespace {

// Uploads the test planet through the pointer calls, as simulation.ts does.
void upload(const Graph& graph, float height) {
  REQUIRE(core_nav_alloc(graph.node_count, static_cast<int>(graph.neighbors.size())) == 1);
  std::copy(graph.directions.begin(), graph.directions.end(), core_nav_directions());
  std::copy(graph.offsets.begin(), graph.offsets.end(), core_nav_neighbor_offsets());
  std::copy(graph.neighbors.begin(), graph.neighbors.end(), core_nav_neighbors());
  std::fill(core_nav_heights(), core_nav_heights() + graph.node_count, height);
  core_nav_commit(kRadius, 0.0);
  core_terrain_set_max_height(kMaxHeight);
}

}  // namespace

TEST_CASE("abi: version, and a clock that starts at zero") {
  CHECK(core_version() == inkulous::kVersion);
  CHECK(std::strcmp(core_version_text(), inkulous::core_version_string()) == 0);
  core_init(0.0);
  CHECK(core_step_ms() == 50.0);
  CHECK(core_step_count() == 0.0);
  CHECK(core_tick(120.0) == 2);
  CHECK(core_step_count() == 2.0);
  CHECK(core_elapsed_ms() == 100.0);
  CHECK(core_pending_ms() == doctest::Approx(20.0));
  core_init(10.0);
  CHECK(core_step_ms() == 10.0);
  CHECK(core_step_count() == 0.0);
  core_init(0.0);
}

TEST_CASE("abi: nothing works before a graph, and every bad id says so") {
  CHECK(core_nav_ready() == 0);
  CHECK(core_nav_nearest_walkable(0.0, 1.0, 0.0) == -1);
  CHECK(core_follower_spawn(0.0, 1.0, 0.0, 0) == -1);
  CHECK(core_nav_alloc(-4, 10) == 0);

  CHECK(core_follower_role(99) == -1);
  CHECK(core_follower_hut(-1) == -1);
  CHECK(core_follower_tree(99) == -1);
  CHECK(core_follower_health(99) == 0.0);
  CHECK(core_follower_set_role(99, 1) == 0);
  CHECK(core_hut_kind(-1) == -1);
  CHECK(core_hut_occupants(5) == -1);
  CHECK(core_hut_tribe(5) == -1);
  CHECK(core_tree_progress(99) == -1.0);
  CHECK(core_wood(99) == 0);
  CHECK(core_mana(99) == 0.0);
  CHECK(core_spell_cost(99) == 0.0);
  CHECK(core_spell_casting(0) == -1);
  CHECK(core_ai_enable(0) == 0);
  CHECK(core_match_over() == 0);
  CHECK(core_match_winner() == -1);
}

TEST_CASE("abi: a planet goes in through pointers, and followers walk on it") {
  const Graph graph = build_graph(12);
  upload(graph, kLand);
  REQUIRE(core_nav_ready() == 1);
  CHECK(core_nav_node_count() == graph.node_count);
  CHECK(core_nav_nearest_walkable(0.0, 1.0, 0.0) >= 0);
  CHECK(core_terrain_height_at(0.0, 1.0, 0.0) == doctest::Approx(static_cast<double>(kLand)));

  const int id = core_follower_spawn(0.0, 0.0, 1.0, 0);
  REQUIRE(id == 0);
  CHECK(core_follower_count() == 1);
  CHECK(core_follower_role(id) == 0);
  CHECK(core_follower_health(id) == core_follower_max_health());
  REQUIRE(core_follower_instance_floats() > 0);
  CHECK(core_follower_instances() != nullptr);

  core_follower_set_selected(id, 1);
  CHECK(core_follower_selected_count() == 1);
  CHECK(core_follower_order_move(1.0, 0.0, 0.2) == 1);
  const int waypoints = core_follower_route(id);
  CHECK(waypoints > 0);
  CHECK(core_route_points() != nullptr);

  for (int i = 0; i < 40; ++i) core_tick(50.0);
  core_follower_clear_selection();
  CHECK(core_follower_selected_count() == 0);
  core_followers_clear();
  CHECK(core_follower_count() == 0);
}

TEST_CASE("abi: huts, trees and wood") {
  CHECK(core_hut_site(0.0, 0.0, 1.0, 0, 0) == 0);
  CHECK(core_hut_cost(0, 0) == 0);
  const int hut = core_hut_place(0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0, 0);
  REQUIRE(hut == 0);
  CHECK(core_hut_count() == 1);
  CHECK(core_hut_tribe(hut) == 0);
  CHECK(core_hut_kind(hut) == 0);
  CHECK(core_hut_site(0.0, 0.0, 1.0, 0, 0) == 4);
  CHECK(core_hut_capacity() == inkulous::kHutCapacity);
  CHECK(core_hut_cost(0, 0) == inkulous::kHutWoodCost);
  core_huts_clear();
  CHECK(core_hut_count() == 0);

  core_wood_set(2, 17);
  CHECK(core_wood(2) == 17);
  core_wood_set(2, 0);
  CHECK(core_trees_spawn(20) > 0);
  CHECK(core_tree_count() > 0);
  CHECK(core_tree_plant(0.0, 0.0, 1.0, 0.0, 0.0) >= 0);
  CHECK(core_tree_progress(0) == 0.0);
  core_trees_clear();
  CHECK(core_tree_count() == 0);
}

TEST_CASE("abi: a shaman casts a spell through check and cast") {
  const int shaman_id = core_shaman_spawn(0.0, 0.0, 1.0, 0);
  REQUIRE(shaman_id >= 0);
  CHECK(core_shaman(0) == shaman_id);
  CHECK(core_spell_count() == inkulous::kSpellCount);
  core_mana_set(0, 1000.0);
  CHECK(core_mana(0) == 1000.0);
  CHECK(core_mana_max() == inkulous::kMaxMana);

  CHECK(core_spell_check(1, 0, 0.1, 0.0, 1.0, 0.0, 0.0, 0.0) == 0);
  CHECK(core_spell_check(99, 0, 0.1, 0.0, 1.0, 0.0, 0.0, 0.0) == 11);
  REQUIRE(core_spell_cast(1, 0, 0.1, 0.0, 1.0, 0.0, 0.0, 0.0) == 0);
  CHECK(core_spell_casting(0) == 1);
  CHECK(core_spell_target(0) != nullptr);
  for (int i = 0; i < 40; ++i) core_tick(50.0);
  CHECK(core_spell_casting(0) == -1);
  CHECK(core_spell_ended(0) == 1);
  CHECK(core_spell_ended_result(0) == 0);
  CHECK(core_terrain_dirty_first() <= core_terrain_dirty_last());
  core_terrain_clear_dirty();
  CHECK(core_terrain_dirty_first() > core_terrain_dirty_last());
}

TEST_CASE("abi: the AI is handed a tribe through the same door") {
  CHECK(core_ai_enable(1) == 0);
  CHECK(core_shaman_spawn(1.0, 0.0, 0.0, 1) >= 0);
  CHECK(core_ai_enable(1) == 1);
  CHECK(core_ai_enabled(1) == 1);
  CHECK(core_ai_think_seconds() == inkulous::kAiThinkSeconds);
  for (int i = 0; i < 100; ++i) core_tick(50.0);
  CHECK(core_ai_thinks(1) > 0);
  core_ai_disable(1);
  CHECK(core_ai_enabled(1) == 0);
}
