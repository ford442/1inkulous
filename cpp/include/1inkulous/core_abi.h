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
// The heights written before commit seed the terrain from the generated
// field. After that the core owns them: only the core_terrain_* edits below
// change walkable height, and TypeScript reads the buffer back to draw it.

// Sizes the graph. `link_count` is the sum of every node's degree. Returns 1 on
// success, 0 on nonsense sizes.
int core_nav_alloc(int node_count, int link_count);

// Pointers into linear memory, valid until the next core_nav_alloc or memory
// growth. Write all four before commit; after it, treat heights as read-only.
// Lengths:
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

// The route a walker standing at (x0, y0, z0) would take to (x1, y1, z1): the
// A* node sequence, string-pulled into straight legs unless `smooth` is 0.
// Writes the waypoints' unit directions into the route buffer and returns how
// many, or -1 if there is no way. For tests and debug drawing; orders do their
// own routing.
int core_nav_route(double x0, double y0, double z0, double x1, double y1, double z1, int smooth);

// --- terrain --------------------------------------------------------------
//
// One height per nav node, which is the walkable surface and the one the mesh
// draws. Edits go through here so a cast an AI makes is applied exactly like
// the player's brush. Each edit widens a dirty node range; the renderer copies
// that range onto the mesh vertices sharing those weld ids and clears it.

// Highest ground in world units above sea level; edits snap to it. 0 leaves
// it unbounded.
void core_terrain_set_max_height(double max_height);
double core_terrain_max_height(void);

// Height under a direction, read off the triangle a walker standing there
// would use. Need not be normalised. 0 with no grid.
double core_terrain_height_at(double x, double y, double z);

// Raises (positive delta) or lowers every node within `angular_radius` radians
// of the direction, by `delta` at the centre and smoothly less to the rim.
// Snaps to sea level and the ceiling. Returns 1 if any node moved.
int core_terrain_sculpt(double x, double y, double z, double angular_radius, double delta);
// Pulls the same disc towards `target_height`, at most `rate` at the centre;
// a node within reach lands on it exactly. Returns 1 if any node moved.
int core_terrain_flatten(double x,
                         double y,
                         double z,
                         double angular_radius,
                         double target_height,
                         double rate);

// Inclusive node range moved since the last clear, first > last when clean.
int core_terrain_dirty_first(void);
int core_terrain_dirty_last(void);
void core_terrain_clear_dirty(void);

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

// Copies the waypoints follower `id` has still to reach into the route buffer
// and returns how many: 0 when it is idle, -1 for a bad id. Read-only debug
// view; the route itself stays in the core.
int core_follower_route(int id);

// The route buffer both route calls write into: 3 floats per waypoint, valid
// until the next route call.
float* core_route_points(void);

// Walking speed in world units per second along the surface.
double core_follower_speed(void);
void core_follower_set_speed(double speed);

// The hut a follower has been ordered into, or -1 (also for a bad id).
int core_follower_hut(int id);
// The tree a follower has been sent to chop, or -1 (also for a bad id).
int core_follower_tree(int id);

// A follower's role: 0 brave, 1 warrior; -1 for a bad id. Mirrors
// inkulous::Role, and rides in the instance flags from bit 3 up.
int core_follower_role(int id);
// Changes it. Returns 1 on success, 0 for a bad id or role, or for the
// shaman. For tests and scenario setup; a training hut is the way in play.
int core_follower_set_role(int id, int role);
// Health left, 0 for a bad id; and what everyone starts with. A follower at
// 0 is taken out of the set on the next fixed step.
double core_follower_health(int id);
double core_follower_max_health(void);
// Sets health, clamped to [0, max]. For tests and scenario setup.
void core_follower_set_health(int id, double health);

// --- huts -----------------------------------------------------------------
//
// The buildings: kind 0 a dwelling, which houses and breeds; kind 1 a
// training hut, which turns a brave and some wood into a warrior. Mirrors
// inkulous::HutKind. Either stands on the nav node nearest the point it is
// placed at, and that node with its neighbours is its footprint: dry, level,
// and from then on blocked to every route and step, like water.
//
// Ids are dense indices into the hut instance buffer, like followers'. Huts
// are never removed during a match, so an id stays good until core_huts_clear.

// Whether `tribe` could build a hut of `kind` on the node nearest the
// direction: 0 yes, otherwise the reason — 1 no grid (or an unknown kind),
// 2 water, 3 uneven, 4 the footprint overlaps or touches another hut's, 5
// the hut ceiling is reached, 6 the tribe is short of the wood. A negative
// tribe asks about the ground alone. Mirrors inkulous::HutSite.
int core_hut_site(double x, double y, double z, int kind, int tribe);

// What the last core_hut_site (or core_hut_place) looked at: 4 floats, the
// anchor node's unit direction — where the hut would be centred — and the
// angle in radians to the furthest node of its footprint. Zeros if there was
// no node. For drawing the build ghost on the patch the core will block.
float* core_hut_site_point(void);

// Builds a hut of `kind` on that node with its door along (hx, hy, hz),
// owned by `tribe`, or unclaimed (and free) until someone goes in if `tribe`
// is negative. Charges the tribe core_hut_cost. Returns its id, or -1 if
// core_hut_site would refuse it. Does not sculpt.
int core_hut_place(double x,
                   double y,
                   double z,
                   double hx,
                   double hy,
                   double hz,
                   int tribe,
                   int kind);
// Wood `tribe`'s next hut of `kind` would cost: 0 for a tribe's first
// dwelling, and for a negative tribe.
int core_hut_cost(int kind, int tribe);

int core_hut_count(void);
void core_huts_clear(void);

// Packed render instances: core_hut_instance_floats() floats each, in id
// order. Moves as huts are built, so re-read it per frame.
float* core_hut_instances(void);
int core_hut_instance_floats(void);

// People inside hut `id`, or -1 for a bad id; and inside every hut together.
int core_hut_occupants(int id);
int core_huts_housed(void);
// Tribe that owns hut `id`: -1 while unclaimed, or for a bad id.
int core_hut_tribe(int id);
// Kind of hut `id`, or -1 for a bad id.
int core_hut_kind(int id);

// Sends selected braves into hut `id`, as many as it has room for. A
// training hut takes nobody while its tribe is short of a warrior's wood.
// Returns how many were sent.
int core_hut_order_enter(int id);
// Sends everyone inside hut `id` back out of the door as braves, as far as
// the follower ceiling allows. Returns how many came out.
int core_hut_eject(int id);

// Fixed rules, so TypeScript draws and picks huts at the size the core
// places them: the mesh's radius in world units, and people per dwelling
// and per training hut.
double core_hut_radius(void);
int core_hut_capacity(void);
int core_training_capacity(void);
// Wood one warrior's training costs, paid as the brave goes in, and how
// long it takes.
int core_warrior_cost(void);
double core_train_seconds(void);

// --- wood and trees -------------------------------------------------------
//
// Wood is one number per tribe (0..3). Trees are points on dry land above the
// shore, scattered once at match start; a brave sent to one chops it down and
// its tribe gets the wood. Ids are dense indices into the tree instance
// buffer and shift down when a tree is felled, like followers'.

// Wood `tribe` holds, 0 for a bad tribe; and a setter for tests and
// scenario setup, clamped at 0.
int core_wood(int tribe);
void core_wood_set(int tribe, int wood);

// Scatters up to `count` trees, chosen by a generator seeded with `seed`,
// replacing any standing. Needs the nav graph. Returns how many stand.
int core_trees_spawn(int count, int seed);
int core_tree_count(void);
void core_trees_clear(void);

// Packed render instances: core_tree_instance_floats() floats each — foot
// position(3), lean heading(3), size, chop progress 0..1 — in id order.
// Moves as trees fall, so re-read it per frame.
float* core_tree_instances(void);
int core_tree_instance_floats(void);

// Sends selected braves to chop tree `id`, the nearest few. Returns how many
// went.
int core_tree_order_chop(int id);
// How far through chopping tree `id` is, 0..1; -1 for a bad id.
double core_tree_progress(int id);
// Wood one tree gives, and the brave-seconds it takes to fell.
int core_tree_wood(void);
double core_tree_chop_seconds(void);

// --- shaman and Land Bridge ---------------------------------------------
//
// The shaman is a follower with kFlagShaman set: select, order and draw her
// through the follower calls. Mana is one number per tribe (0..3), filled
// every fixed step by the tribe's population.
//
// A cast is decided and carried out here: on success the core charges the
// mana and raises the land through the terrain edits above, so the dirty range
// covers it. The stamps it laid — directions, a crest height and a stamp
// radius — stay readable for the ghost and for tests. A refused cast raises
// nothing and keeps no stamps.

// Spawns `tribe`'s shaman on the walkable node nearest the direction. Returns
// her follower id, or -1 if the tribe already has one or there is no land.
int core_shaman_spawn(double x, double y, double z, int tribe);
// `tribe`'s shaman's follower id, or -1. Ids shift as followers go into huts,
// so look it up each time rather than keeping it.
int core_shaman(int tribe);

// Mana `tribe` holds, 0 for a bad tribe; what it gains per second right now;
// and the ceiling it stops at.
double core_mana(int tribe);
double core_mana_income(int tribe);
double core_mana_max(void);
// Sets a tribe's mana, clamped to [0, max]. For tests and scenario setup.
void core_mana_set(int tribe, double mana);

// Mana a Land Bridge costs, and how far from the shaman, in world units along
// the surface, both of its ends may lie.
double core_land_bridge_cost(void);
double core_land_bridge_range(void);

// Whether `tribe`'s shaman could raise a bridge from (x0, y0, z0) to (x1, y1,
// z1): 0 yes, otherwise the reason — 1 no grid, 2 no shaman, 3 an end out of
// range, 4 neither end near land, 5 already dry, 6 not enough mana. Mirrors
// inkulous::LandBridge. Charges nothing.
int core_land_bridge_check(int tribe, double x0, double y0, double z0, double x1, double y1, double z1);
// The same check; on 0 the mana is spent and the land is raised. Any other
// result changes nothing and empties the stamps.
int core_land_bridge_cast(int tribe, double x0, double y0, double z0, double x1, double y1, double z1);

// What the last cast laid: core_land_bridge_stamp_count() stamps of 3 floats (a
// unit direction) each; every stamp's angular radius in radians; and the
// height above sea level the stamps raise the centre line to.
int core_land_bridge_stamp_count(void);
float* core_land_bridge_stamps(void);
double core_land_bridge_stamp_radius(void);
double core_land_bridge_height(void);

#ifdef __cplusplus
}  // extern "C"
#endif
