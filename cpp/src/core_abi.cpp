// Thin shims between the flat C ABI and the C++ core. Keeping the boundary in
// one file makes it obvious what TypeScript is allowed to touch.

#include "1inkulous/core_abi.h"

#include "1inkulous/core.hpp"

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

}  // namespace

extern "C" {

INKULOUS_EXPORT int core_version(void) { return inkulous::core_version(); }

INKULOUS_EXPORT const char* core_version_text(void) {
  return inkulous::core_version_string();
}

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

// --- navigation grid ------------------------------------------------------

INKULOUS_EXPORT int core_nav_alloc(int node_count, int link_count) {
  return simulation().nav().allocate(node_count, link_count) ? 1 : 0;
}

INKULOUS_EXPORT float* core_nav_directions(void) {
  return simulation().nav().directions();
}

INKULOUS_EXPORT float* core_nav_heights(void) { return simulation().nav().heights(); }

INKULOUS_EXPORT int* core_nav_neighbor_offsets(void) {
  return simulation().nav().neighbor_offsets();
}

INKULOUS_EXPORT int* core_nav_neighbors(void) { return simulation().nav().neighbors(); }

INKULOUS_EXPORT void core_nav_commit(double planet_radius, double max_slope) {
  simulation().nav().commit(planet_radius, max_slope);
}

INKULOUS_EXPORT int core_nav_node_count(void) {
  return simulation().nav().node_count();
}

INKULOUS_EXPORT int core_nav_ready(void) { return simulation().nav().ready() ? 1 : 0; }

INKULOUS_EXPORT int core_nav_nearest_walkable(double x, double y, double z) {
  return simulation().nav().nearest_walkable_node(x, y, z);
}

// --- followers ------------------------------------------------------------

INKULOUS_EXPORT int core_follower_spawn(double x, double y, double z, int tribe) {
  const int id = simulation().followers().spawn(x, y, z, tribe);
  if (id >= 0) {
    simulation().followers().refresh_instances();
  }
  return id;
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

INKULOUS_EXPORT double core_follower_speed(void) {
  return simulation().followers().speed();
}

INKULOUS_EXPORT void core_follower_set_speed(double speed) {
  simulation().followers().set_speed(speed);
}

}  // extern "C"
