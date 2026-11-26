// Thin shims between the flat C ABI and the C++ core. Keeping the boundary in
// one file makes it obvious what TypeScript is allowed to touch.

#include "1inkulous/core_abi.h"

#include "1inkulous/core.hpp"

#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define INKULOUS_EXPORT EMSCRIPTEN_KEEPALIVE
#else
// Native builds (unit tests, tooling) need no export annotation.
#define INKULOUS_EXPORT
#endif

namespace {

// One world per module, matching the single world a match is played on. It is
// created on first use and lives for the session; core_init only re-times it.
inkulous::Simulation& simulation() {
  static inkulous::Simulation instance{inkulous::kDefaultStepMs};
  return instance;
}

// Shared output of the two route calls. Debug traffic only: nothing reads it
// per frame.
std::vector<float>& route_points() {
  static std::vector<float> points;
  return points;
}

int write_route(const std::vector<inkulous::NavPoint>& route) {
  std::vector<float>& points = route_points();
  points.resize(route.size() * 3);
  for (std::size_t i = 0; i < route.size(); ++i) {
    points[i * 3] = static_cast<float>(route[i].dir[0]);
    points[i * 3 + 1] = static_cast<float>(route[i].dir[1]);
    points[i * 3 + 2] = static_cast<float>(route[i].dir[2]);
  }
  return static_cast<int>(route.size());
}

const inkulous::SpellRules* rules_of(int spell) {
  return inkulous::valid_spell(spell) ? &inkulous::kSpellRules[spell] : nullptr;
}

inkulous::SpellTarget spell_target(double x, double y, double z, double ox, double oy, double oz) {
  inkulous::SpellTarget target;
  target.at[0] = x;
  target.at[1] = y;
  target.at[2] = z;
  target.from[0] = ox;
  target.from[1] = oy;
  target.from[2] = oz;
  return target;
}

}  // namespace

extern "C" {

INKULOUS_EXPORT int core_version(void) { return inkulous::core_version(); }

INKULOUS_EXPORT const char* core_version_text(void) { return inkulous::core_version_string(); }

INKULOUS_EXPORT void core_init(double step_ms) { simulation().set_step_ms(step_ms); }

INKULOUS_EXPORT int core_tick(double delta_ms) {
  return static_cast<int>(simulation().advance(delta_ms));
}

INKULOUS_EXPORT double core_step_ms(void) { return simulation().step_ms(); }

INKULOUS_EXPORT double core_step_count(void) {
  return static_cast<double>(simulation().step_count());
}

INKULOUS_EXPORT double core_elapsed_ms(void) { return simulation().elapsed_ms(); }

INKULOUS_EXPORT double core_pending_ms(void) { return simulation().pending_ms(); }

INKULOUS_EXPORT void core_reset(void) { simulation().reset(); }

INKULOUS_EXPORT int core_steps(int count) {
  return static_cast<int>(simulation().run_steps(count));
}

INKULOUS_EXPORT double core_step_alpha(void) { return simulation().step_alpha(); }

// --- determinism ----------------------------------------------------------

INKULOUS_EXPORT void core_match_seed(int seed) {
  simulation().seed_match(static_cast<std::uint32_t>(seed));
}

INKULOUS_EXPORT int core_match_seed_value(void) {
  return static_cast<int>(simulation().random().seed());
}

INKULOUS_EXPORT int core_state_hash(void) { return static_cast<int>(simulation().state_hash()); }

INKULOUS_EXPORT int core_checkpoint_every(void) { return inkulous::kCheckpointEverySteps; }

INKULOUS_EXPORT int core_checkpoint_count(void) {
  return static_cast<int>(simulation().checkpoints().size());
}

INKULOUS_EXPORT double core_checkpoint_step(int index) {
  const auto& checkpoints = simulation().checkpoints();
  return index >= 0 && static_cast<std::size_t>(index) < checkpoints.size()
             ? static_cast<double>(checkpoints[static_cast<std::size_t>(index)].step)
             : 0.0;
}

INKULOUS_EXPORT int core_checkpoint_hash(int index) {
  const auto& checkpoints = simulation().checkpoints();
  return index >= 0 && static_cast<std::size_t>(index) < checkpoints.size()
             ? static_cast<int>(checkpoints[static_cast<std::size_t>(index)].hash)
             : 0;
}

// --- navigation grid ------------------------------------------------------

INKULOUS_EXPORT int core_nav_alloc(int node_count, int link_count) {
  return simulation().nav().allocate(node_count, link_count) ? 1 : 0;
}

INKULOUS_EXPORT float* core_nav_directions(void) { return simulation().nav().directions(); }

INKULOUS_EXPORT float* core_nav_heights(void) { return simulation().nav().heights(); }

INKULOUS_EXPORT int* core_nav_neighbor_offsets(void) {
  return simulation().nav().neighbor_offsets();
}

INKULOUS_EXPORT int* core_nav_neighbors(void) { return simulation().nav().neighbors(); }

INKULOUS_EXPORT void core_nav_commit(double planet_radius, double max_slope) {
  simulation().nav().commit(planet_radius, max_slope);
  // The heights written before commit are the seed, and the mesh was built
  // from the same field: nothing for it to copy back yet.
  simulation().terrain().clear_dirty();
}

INKULOUS_EXPORT int core_nav_node_count(void) { return simulation().nav().node_count(); }

INKULOUS_EXPORT int core_nav_ready(void) { return simulation().nav().ready() ? 1 : 0; }

INKULOUS_EXPORT int core_nav_nearest_walkable(double x, double y, double z) {
  return simulation().nav().nearest_walkable_node(x, y, z);
}

INKULOUS_EXPORT int core_nav_route(
    double x0, double y0, double z0, double x1, double y1, double z1, int smooth) {
  inkulous::NavGrid& nav = simulation().nav();
  if (!nav.ready()) {
    return -1;
  }
  const int from = nav.nearest_walkable_node(x0, y0, z0);
  const int to = nav.nearest_walkable_node(x1, y1, z1);
  std::vector<int> nodes;
  if (from < 0 || to < 0 || !nav.find_path(from, to, nodes)) {
    return -1;
  }

  std::vector<inkulous::NavPoint> route;
  if (smooth == 0) {
    for (const int node : nodes) {
      inkulous::NavPoint point;
      const float* d = nav.direction(node);
      point.dir[0] = d[0];
      point.dir[1] = d[1];
      point.dir[2] = d[2];
      point.node = node;
      route.push_back(point);
    }
    return write_route(route);
  }

  inkulous::NavPoint start;
  start.dir[0] = x0;
  start.dir[1] = y0;
  start.dir[2] = z0;
  start.node = from;
  inkulous::NavPoint goal;
  const float* d = nav.direction(to);
  goal.dir[0] = d[0];
  goal.dir[1] = d[1];
  goal.dir[2] = d[2];
  goal.node = to;
  nav.smooth_path(start, nodes, goal, route);
  return write_route(route);
}

// --- terrain --------------------------------------------------------------

INKULOUS_EXPORT void core_terrain_set_max_height(double max_height) {
  simulation().terrain().set_max_height(max_height);
}

INKULOUS_EXPORT double core_terrain_max_height(void) { return simulation().terrain().max_height(); }

INKULOUS_EXPORT double core_terrain_height_at(double x, double y, double z) {
  const double dir[3] = {x, y, z};
  return simulation().terrain().height_at(dir);
}

INKULOUS_EXPORT int core_terrain_sculpt(
    double x, double y, double z, double angular_radius, double delta) {
  const double centre[3] = {x, y, z};
  const inkulous::NodeRange moved = simulation().terrain().sculpt(centre, angular_radius, delta);
  return moved.empty() ? 0 : 1;
}

INKULOUS_EXPORT int core_terrain_flatten(
    double x, double y, double z, double angular_radius, double target_height, double rate) {
  const double centre[3] = {x, y, z};
  const inkulous::NodeRange moved =
      simulation().terrain().flatten(centre, angular_radius, target_height, rate);
  return moved.empty() ? 0 : 1;
}

INKULOUS_EXPORT int core_terrain_dirty_first(void) { return simulation().terrain().dirty().first; }

INKULOUS_EXPORT int core_terrain_dirty_last(void) { return simulation().terrain().dirty().last; }

INKULOUS_EXPORT void core_terrain_clear_dirty(void) { simulation().terrain().clear_dirty(); }

// --- worlds ---------------------------------------------------------------

INKULOUS_EXPORT int core_terrain_generate(int seed,
                                          double land,
                                          int continents,
                                          double continent_size,
                                          double continent_weight,
                                          double frequency,
                                          int octaves,
                                          double persistence,
                                          double lacunarity,
                                          double warp,
                                          double ridges,
                                          double relief,
                                          double peak,
                                          int smoothing) {
  inkulous::WorldGenParams params;
  params.seed = static_cast<std::uint32_t>(seed);
  params.land = land;
  params.continents = continents;
  params.continent_size = continent_size;
  params.continent_weight = continent_weight;
  params.frequency = frequency;
  params.octaves = octaves;
  params.persistence = persistence;
  params.lacunarity = lacunarity;
  params.warp = warp;
  params.ridges = ridges;
  params.relief = relief;
  params.peak = peak;
  params.smoothing = smoothing;
  return simulation().terrain().generate(params);
}

INKULOUS_EXPORT void core_terrain_touch_all(void) { simulation().terrain().touch_all(); }

INKULOUS_EXPORT void core_world_clear(void) { simulation().clear_world(); }

// --- followers ------------------------------------------------------------

INKULOUS_EXPORT int core_follower_spawn(double x, double y, double z, int tribe) {
  return simulation().followers().spawn(x, y, z, tribe);
}

INKULOUS_EXPORT int core_follower_count(void) { return simulation().followers().count(); }

INKULOUS_EXPORT void core_followers_clear(void) { simulation().followers().clear(); }

INKULOUS_EXPORT float* core_follower_instances(void) {
  // const_cast because the ABI deals in plain pointers; the JS side only reads.
  return const_cast<float*>(simulation().followers().instances());
}

INKULOUS_EXPORT int core_follower_instance_floats(void) {
  return inkulous::kFollowerInstanceFloats;
}

INKULOUS_EXPORT void core_follower_set_selected(int id, int selected) {
  simulation().followers().set_selected(id, selected != 0);
  simulation().followers().refresh_instances();
}

INKULOUS_EXPORT void core_follower_clear_selection(void) {
  simulation().followers().clear_selection();
  simulation().followers().refresh_instances();
}

INKULOUS_EXPORT int core_follower_selected_count(void) {
  return simulation().followers().selected_count();
}

INKULOUS_EXPORT int core_follower_order_move(double x, double y, double z) {
  const int routed = simulation().followers().order_move_selected(x, y, z);
  simulation().followers().refresh_instances();
  return routed;
}

INKULOUS_EXPORT int core_follower_route(int id) {
  std::vector<inkulous::NavPoint> route;
  if (!simulation().followers().route(id, route)) {
    return -1;
  }
  return write_route(route);
}

INKULOUS_EXPORT float* core_route_points(void) { return route_points().data(); }

INKULOUS_EXPORT double core_follower_speed(void) { return simulation().followers().speed(); }

INKULOUS_EXPORT void core_follower_set_speed(double speed) {
  simulation().followers().set_speed(speed);
}

INKULOUS_EXPORT int core_follower_hut(int id) { return simulation().followers().hut(id); }

INKULOUS_EXPORT int core_follower_tree(int id) { return simulation().followers().tree(id); }

INKULOUS_EXPORT int core_follower_role(int id) {
  inkulous::FollowerSet& followers = simulation().followers();
  if (id < 0 || id >= followers.count()) {
    return -1;
  }
  return static_cast<int>(followers.role(id));
}

INKULOUS_EXPORT int core_follower_set_role(int id, int role) {
  return simulation().followers().set_role(id, static_cast<inkulous::Role>(role)) ? 1 : 0;
}

INKULOUS_EXPORT double core_follower_health(int id) {
  inkulous::FollowerSet& followers = simulation().followers();
  if (id < 0 || id >= followers.count()) {
    return 0.0;
  }
  return followers.health(id);
}

INKULOUS_EXPORT double core_follower_max_health(void) { return inkulous::kFollowerHealth; }

INKULOUS_EXPORT void core_follower_set_health(int id, double health) {
  simulation().followers().set_health(id, health);
}

// --- huts -----------------------------------------------------------------

INKULOUS_EXPORT int core_hut_site(double x, double y, double z, int kind, int tribe) {
  return static_cast<int>(
      simulation().huts().check_site(x, y, z, static_cast<inkulous::HutKind>(kind), tribe));
}

INKULOUS_EXPORT float* core_hut_site_point(void) {
  return const_cast<float*>(simulation().huts().site_point());
}

INKULOUS_EXPORT int core_hut_place(
    double x, double y, double z, double hx, double hy, double hz, int tribe, int kind) {
  const int id =
      simulation().huts().place(x, y, z, hx, hy, hz, tribe, static_cast<inkulous::HutKind>(kind));
  if (id >= 0) {
    simulation().followers().refresh_instances();
  }
  return id;
}

INKULOUS_EXPORT int core_hut_cost(int kind, int tribe) {
  return simulation().huts().cost(static_cast<inkulous::HutKind>(kind), tribe);
}

INKULOUS_EXPORT int core_hut_count(void) { return simulation().huts().count(); }

INKULOUS_EXPORT void core_huts_clear(void) { simulation().huts().clear(); }

INKULOUS_EXPORT float* core_hut_instances(void) {
  return const_cast<float*>(simulation().huts().instances());
}

INKULOUS_EXPORT int core_hut_instance_floats(void) { return inkulous::kHutInstanceFloats; }

INKULOUS_EXPORT int core_hut_occupants(int id) { return simulation().huts().occupants(id); }

INKULOUS_EXPORT int core_huts_housed(void) { return simulation().huts().housed(); }

INKULOUS_EXPORT int core_hut_tribe(int id) { return simulation().huts().tribe(id); }

INKULOUS_EXPORT int core_hut_kind(int id) { return simulation().huts().kind(id); }

INKULOUS_EXPORT int core_hut_order_enter(int id) {
  const int sent = simulation().huts().order_enter_selected(id);
  simulation().followers().refresh_instances();
  return sent;
}

INKULOUS_EXPORT int core_hut_eject(int id) {
  const int out = simulation().huts().eject(id);
  simulation().followers().refresh_instances();
  return out;
}

INKULOUS_EXPORT double core_hut_radius(void) { return inkulous::kHutRadius; }

INKULOUS_EXPORT int core_hut_capacity(void) { return inkulous::kHutCapacity; }

INKULOUS_EXPORT int core_training_capacity(void) { return inkulous::kTrainingCapacity; }

INKULOUS_EXPORT int core_warrior_cost(void) { return inkulous::kWarriorWoodCost; }

INKULOUS_EXPORT double core_train_seconds(void) { return inkulous::kTrainSeconds; }

// --- wood and trees -------------------------------------------------------

INKULOUS_EXPORT int core_wood(int tribe) { return simulation().stores().wood(tribe); }

INKULOUS_EXPORT void core_wood_set(int tribe, int wood) {
  simulation().stores().set_wood(tribe, wood);
}

INKULOUS_EXPORT int core_trees_spawn(int count) {
  return simulation().trees().spawn(count, simulation().random());
}

INKULOUS_EXPORT int core_tree_count(void) { return simulation().trees().count(); }

INKULOUS_EXPORT void core_trees_clear(void) { simulation().trees().clear(); }

INKULOUS_EXPORT float* core_tree_instances(void) {
  return const_cast<float*>(simulation().trees().instances());
}

INKULOUS_EXPORT int core_tree_instance_floats(void) { return inkulous::kTreeInstanceFloats; }

INKULOUS_EXPORT int core_tree_order_chop(int id) {
  return simulation().trees().order_chop_selected(id);
}

INKULOUS_EXPORT double core_tree_progress(int id) { return simulation().trees().progress(id); }

INKULOUS_EXPORT int core_tree_wood(void) { return inkulous::kWoodPerTree; }

INKULOUS_EXPORT double core_tree_chop_seconds(void) { return inkulous::kChopSeconds; }

// --- shaman and spells ---------------------------------------------------

INKULOUS_EXPORT int core_shaman_spawn(double x, double y, double z, int tribe) {
  return simulation().shamans().spawn(x, y, z, tribe);
}

INKULOUS_EXPORT int core_shaman(int tribe) {
  if (tribe < 0 || tribe >= inkulous::kMaxTribes) {
    return -1;
  }
  return simulation().followers().shaman(tribe);
}

INKULOUS_EXPORT double core_mana(int tribe) { return simulation().shamans().mana(tribe); }

INKULOUS_EXPORT double core_mana_income(int tribe) { return simulation().shamans().income(tribe); }

INKULOUS_EXPORT double core_mana_max(void) { return inkulous::kMaxMana; }

INKULOUS_EXPORT void core_mana_set(int tribe, double mana) {
  simulation().shamans().set_mana(tribe, mana);
}

INKULOUS_EXPORT int core_spell_count(void) { return inkulous::kSpellCount; }

INKULOUS_EXPORT double core_spell_cost(int spell) {
  return rules_of(spell) ? rules_of(spell)->cost : 0.0;
}

INKULOUS_EXPORT double core_spell_range(int spell) {
  return rules_of(spell) ? rules_of(spell)->range : 0.0;
}

INKULOUS_EXPORT double core_spell_cast_seconds(int spell) {
  return rules_of(spell) ? rules_of(spell)->cast_seconds : 0.0;
}

INKULOUS_EXPORT double core_spell_cooldown_seconds(int spell) {
  return rules_of(spell) ? rules_of(spell)->cooldown_seconds : 0.0;
}

INKULOUS_EXPORT double core_spell_radius(int spell) {
  return rules_of(spell) ? simulation().shamans().spell_angle(static_cast<inkulous::Spell>(spell))
                         : 0.0;
}

INKULOUS_EXPORT int core_spell_check(
    int spell, int tribe, double x, double y, double z, double ox, double oy, double oz) {
  return static_cast<int>(simulation().shamans().check(static_cast<inkulous::Spell>(spell), tribe,
                                                       spell_target(x, y, z, ox, oy, oz)));
}

INKULOUS_EXPORT int core_spell_cast(
    int spell, int tribe, double x, double y, double z, double ox, double oy, double oz) {
  return static_cast<int>(simulation().shamans().cast(static_cast<inkulous::Spell>(spell), tribe,
                                                      spell_target(x, y, z, ox, oy, oz)));
}

INKULOUS_EXPORT void core_spell_cancel(int tribe) { simulation().shamans().cancel(tribe); }

INKULOUS_EXPORT void core_spell_set_unlock(int tribe, int spell, int at) {
  if (inkulous::valid_spell(spell)) {
    simulation().shamans().set_unlock(tribe, static_cast<inkulous::Spell>(spell), at);
  }
}

INKULOUS_EXPORT int core_spell_unlock_at(int tribe, int spell) {
  if (!inkulous::valid_spell(spell)) {
    return inkulous::kSpellNever;
  }
  return simulation().shamans().unlock_at(tribe, static_cast<inkulous::Spell>(spell));
}

INKULOUS_EXPORT int core_spell_casting(int tribe) { return simulation().shamans().casting(tribe); }

INKULOUS_EXPORT double core_spell_progress(int tribe) {
  return simulation().shamans().cast_progress(tribe);
}

INKULOUS_EXPORT float* core_spell_target(int tribe) {
  static float target[4];
  double at[3];
  double angle = 0.0;
  if (simulation().shamans().cast_disc(tribe, at, angle)) {
    target[0] = static_cast<float>(at[0]);
    target[1] = static_cast<float>(at[1]);
    target[2] = static_cast<float>(at[2]);
    target[3] = static_cast<float>(angle);
  } else {
    target[0] = target[1] = target[2] = target[3] = 0.0f;
  }
  return target;
}

INKULOUS_EXPORT double core_spell_cooldown(int tribe, int spell) {
  return inkulous::valid_spell(spell)
             ? simulation().shamans().cooldown(tribe, static_cast<inkulous::Spell>(spell))
             : 0.0;
}

INKULOUS_EXPORT int core_spell_ended(int tribe) {
  return static_cast<int>(simulation().shamans().last_end(tribe).count);
}

INKULOUS_EXPORT int core_spell_ended_spell(int tribe) {
  return static_cast<int>(simulation().shamans().last_end(tribe).spell);
}

INKULOUS_EXPORT int core_spell_ended_result(int tribe) {
  return static_cast<int>(simulation().shamans().last_end(tribe).result);
}

INKULOUS_EXPORT int core_land_bridge_stamp_count(void) {
  return simulation().shamans().stamp_count();
}

INKULOUS_EXPORT float* core_land_bridge_stamps(void) {
  return const_cast<float*>(simulation().shamans().stamps());
}

INKULOUS_EXPORT double core_land_bridge_height(void) { return inkulous::kLandBridgeHeight; }

INKULOUS_EXPORT int core_population(int tribe) { return simulation().shamans().population(tribe); }

INKULOUS_EXPORT int core_tree_plant(double x, double y, double z, double size, double turn) {
  return simulation().trees().plant(x, y, z, size, turn);
}

INKULOUS_EXPORT double core_tree_size(int id) { return simulation().trees().size(id); }

INKULOUS_EXPORT double core_tree_turn(int id) { return simulation().trees().turn(id); }

INKULOUS_EXPORT int core_shaman_fallen(int tribe) {
  return simulation().followers().fallen(tribe) ? 1 : 0;
}

INKULOUS_EXPORT int core_match_over(void) { return simulation().shamans().match_over() ? 1 : 0; }

INKULOUS_EXPORT int core_match_winner(void) { return simulation().shamans().winner(); }

INKULOUS_EXPORT int core_ai_enable(int tribe) { return simulation().ai().enable(tribe) ? 1 : 0; }

INKULOUS_EXPORT void core_ai_disable(int tribe) { simulation().ai().disable(tribe); }

INKULOUS_EXPORT int core_ai_enabled(int tribe) { return simulation().ai().enabled(tribe) ? 1 : 0; }

INKULOUS_EXPORT int core_ai_last_action(int tribe) {
  return static_cast<int>(simulation().ai().last_action(tribe));
}

INKULOUS_EXPORT int core_ai_actions(int tribe) { return simulation().ai().actions(tribe); }

INKULOUS_EXPORT int core_ai_thinks(int tribe) { return simulation().ai().thinks(tribe); }

INKULOUS_EXPORT double core_ai_think_seconds(void) { return inkulous::kAiThinkSeconds; }

INKULOUS_EXPORT int core_ai_configure(int tribe,
                                      double think_seconds,
                                      int hut_cap,
                                      double build_reach,
                                      double forage_reach,
                                      int patch,
                                      int muster,
                                      int settle,
                                      int bridges) {
  inkulous::AiPersonality personality;
  personality.think_seconds = think_seconds;
  personality.hut_cap = hut_cap;
  personality.build_reach = build_reach;
  personality.forage_reach = forage_reach;
  personality.patch = patch;
  personality.muster = muster;
  personality.settle = settle;
  personality.bridges = bridges != 0;
  return simulation().ai().configure(tribe, personality) ? 1 : 0;
}

INKULOUS_EXPORT double core_ai_personality(int tribe, int field) {
  if (!inkulous::valid_tribe(tribe)) {
    return 0.0;
  }
  const inkulous::AiPersonality& p = simulation().ai().personality(tribe);
  switch (field) {
    case 0:
      return p.think_seconds;
    case 1:
      return p.hut_cap;
    case 2:
      return p.build_reach;
    case 3:
      return p.forage_reach;
    case 4:
      return p.patch;
    case 5:
      return p.muster;
    case 6:
      return p.settle;
    case 7:
      return p.bridges ? 1.0 : 0.0;
    default:
      return 0.0;
  }
}

}  // extern "C"
