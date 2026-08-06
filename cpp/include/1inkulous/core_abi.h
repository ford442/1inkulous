#pragma once

// Flat C ABI exposed to TypeScript across the WebAssembly boundary.
//
// Everything here is scalar in and scalar out. There is no marshalling of
// structs or strings into WASM, and nothing is copied per frame — as the
// simulation grows, bulk state should be read straight out of the module's
// linear memory (or written into it as a command buffer) rather than passed
// through these calls.
//
// The module owns a single simulation instance, matching the single world a
// match is played on. `core_init` (re)creates it.

#ifdef __cplusplus
extern "C" {
#endif

// Encoded as MAJOR * 10000 + MINOR * 100 + PATCH.
int core_version(void);

// Pointer to a static NUL-terminated version string, e.g. "0.1.0". Read it on
// the JS side with UTF8ToString.
const char* core_version_text(void);

// Creates the simulation with a fixed step length. Pass 0 for the default.
// Calling it again resets the clock.
void core_init(double step_ms);

// Feeds a frame's elapsed time in and runs whole fixed steps. Returns the
// number of steps executed this call, which may be 0 on a fast frame.
int core_tick(double delta_ms);

// Fixed step length in milliseconds.
double core_step_ms(void);

// Total steps run since init. A double, because an int64 does not cross the
// boundary cleanly and 2^53 steps is longer than any match.
double core_step_count(void);

// Simulated time in milliseconds: whole steps only.
double core_elapsed_ms(void);

// Time accumulated towards the next step, in milliseconds.
double core_pending_ms(void);

// Clears the clock, keeping the step length.
void core_reset(void);

// --- navigation grid ------------------------------------------------------
//
// The graph is the planet mesh's welded vertex grid, built once on the
// TypeScript side and written straight into core memory. The flow is:
//
//   core_nav_alloc(nodes, links)
//   fill core_nav_directions / _neighbor_offsets / _neighbors / _heights
//   core_nav_commit(radius, max_slope)
//
// and after that only the heights buffer is ever touched again — terrain
// deformation overwrites it in place and the next path search sees the change.

// Sizes the graph. `link_count` is the sum of every node's degree. Returns 1 on
// success, 0 on nonsense sizes.
int core_nav_alloc(int node_count, int link_count);

// Pointers into linear memory, valid until the next core_nav_alloc. Lengths:
// directions 3*N floats (unit vectors), heights N floats, offsets N+1 ints
// (CSR), neighbours link_count ints.
float* core_nav_directions(void);
float* core_nav_heights(void);
int* core_nav_neighbor_offsets(void);
int* core_nav_neighbors(void);

// Finishes setup. `max_slope` is height change over arc length — the tangent of
// the steepest walkable slope. Pass 0 for the default.
void core_nav_commit(double planet_radius, double max_slope);

int core_nav_node_count(void);
// 1 once the graph is committed and usable.
int core_nav_ready(void);
// Index of the walkable node nearest a direction, or -1. Handy for tests and
// for placing things without duplicating the search in TypeScript.
int core_nav_nearest_walkable(double x, double y, double z);

// --- followers ------------------------------------------------------------
//
// Ids are dense indices into the instance buffer, so TypeScript can pick a
// follower out of the buffer it already reads for rendering and hand the index
// straight back here.

// Places a follower on the walkable node nearest the direction. Returns its id,
// or -1 if there is no land nearby, no grid, or no room.
int core_follower_spawn(double x, double y, double z, int tribe);
int core_follower_count(void);
void core_followers_clear(void);

// Packed render instances: core_follower_instance_floats() floats each, in id
// order. The pointer moves when the population grows, so re-read it per frame.
float* core_follower_instances(void);
int core_follower_instance_floats(void);

void core_follower_set_selected(int id, int selected);
void core_follower_clear_selection(void);
int core_follower_selected_count(void);

// Paths every selected follower to the terrain point under the direction.
// Returns how many found a route.
int core_follower_order_move(double x, double y, double z);

// Walking speed in world units per second along the surface.
double core_follower_speed(void);
void core_follower_set_speed(double speed);

#ifdef __cplusplus
}  // extern "C"
#endif
