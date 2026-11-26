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

// Clears the clock and its checkpoints, keeping the step length.
void core_reset(void);

// Runs exactly `count` fixed steps, leaving the accumulator alone: how a
// replay or a lockstep peer drives the core, by step number rather than by
// frame time. Returns how many ran.
int core_steps(int count);

// How far the clock has got from the last step towards the next, in [0, 1):
// core_pending_ms over core_step_ms. The renderer draws each follower that far
// from its previous pose to its current one (see core_follower_instances).
double core_step_alpha(void);

// --- determinism ----------------------------------------------------------
//
// The same seed and the same commands, landing on the same steps, give the
// same match: the same state hash after every step, in Node or a browser, in
// a release core or a debug one. Replays and lockstep both rest on it.

// Seeds the match's random generator — the only source of chance in the
// core. Call it as the match starts, before anything draws from it (the
// forest). The seed is a uint32 crossing as an int.
void core_match_seed(int seed);
// The seed the generator was last seeded with (a uint32, as an int; read it
// with `>>> 0`). A fresh core holds the default seed.
int core_match_seed_value(void);

// FNV-1a over everything that decides the next step — followers and their
// routes, huts, trees, stores, mana, casts, the AI, the ground, the random
// state — but not render buffers or scratch. A uint32 crossing as an int.
int core_state_hash(void);

// The hash is also taken every core_checkpoint_every() steps, as that step
// ends, and kept since the clock was last cleared. Index 0 is the oldest.
int core_checkpoint_every(void);
int core_checkpoint_count(void);
// The step a checkpoint was taken on (a double, like core_step_count), and its
// hash (a uint32 as an int). 0 for a bad index.
double core_checkpoint_step(int index);
int core_checkpoint_hash(int index);

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
int core_terrain_flatten(
    double x, double y, double z, double angular_radius, double target_height, double rate);

// Inclusive node range moved since the last clear, first > last when clean.
int core_terrain_dirty_first(void);
int core_terrain_dirty_last(void);
void core_terrain_clear_dirty(void);

// --- worlds ---------------------------------------------------------------
//
// A scenario's procedural terrain is generated here, not uploaded: the whole
// field from a seed and the parameters of inkulous::WorldGenParams (see
// worldgen.hpp for what each one does), each clamped to its range. Every node
// is written, under the ceiling, and the whole range marked dirty. Drawn from
// a generator of its own, so it leaves the match's random state alone.
// Returns how many nodes are land, or -1 with no grid.
int core_terrain_generate(int seed,
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
                          int smoothing);

// Marks every node dirty: after a scenario's own height field (or the
// editor's) was written into core_nav_heights wholesale.
void core_terrain_touch_all(void);

// Takes everything off the world but the ground and the clock: every
// follower, hut, tree, shaman's mana, cast, cooldown and unlock, every
// tribe's wood, and every AI mind and personality. What the editor rebuilds
// a world on.
void core_world_clear(void);

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
// order — position(3), heading(3), tribe, flags, then the position(3) and
// heading(3) the follower had as the last step began. Draw it between the two
// by core_step_alpha(). The pointer moves when the population grows, so
// re-read it per frame.
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
int core_hut_place(
    double x, double y, double z, double hx, double hy, double hz, int tribe, int kind);
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

// Scatters up to `count` trees, drawn from the match's generator (see
// core_match_seed), replacing any standing. Needs the nav graph. Returns how
// many stand.
int core_trees_spawn(int count);
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
// Plants one tree on the walkable node nearest the direction, unless one
// stands there already: `size` a multiple of the placeholder mesh (0 is 1),
// `turn` the way it leans, in radians round its node. Returns its id, or -1.
// For tests, scenarios and the editor.
int core_tree_plant(double x, double y, double z, double size, double turn);
// Tree `id`'s size and lean as core_tree_plant takes them, so a scattered
// forest can be written out and planted back exactly; 0 for a bad id.
double core_tree_size(int id);
double core_tree_turn(int id);
// Wood one tree gives, and the brave-seconds it takes to fell.
int core_tree_wood(void);
double core_tree_chop_seconds(void);

// --- shaman and spells ---------------------------------------------------
//
// The shaman is a follower with kFlagShaman set: select, order and draw her
// through the follower calls. Mana is one number per tribe (0..3), filled
// every fixed step by the tribe's population.
//
// Spells are ids (0 Land Bridge, 1 Blast, 2 Flatten, 3 Swamp; mirrors
// inkulous::Spell) on one path: core_spell_check says whether one would go
// ahead, core_spell_cast starts it. A cast takes the spell's cast time, during
// which the shaman stands still with kFlagCasting set; a move order, another
// cast or her leaving the spell's range ends it with nothing spent. When it
// lands, the core charges the mana and writes the terrain through the edits
// above, so the dirty range covers it.
//
// Results, from check and as how a cast ended: 0 ok, 1 no grid, 2 no shaman,
// 3 out of range, 4 neither end of a bridge near land, 5 the bridge's line is
// dry already, 6 not enough mana, 7 cooling down, 8 nothing to do, 9 the
// centre is under water, 10 cancelled, 11 no such spell, 12 not unlocked yet.
// Mirrors inkulous::SpellResult.

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
// Everyone of `tribe`, out walking or inside a hut, as of the last step: what
// its mana income is counted from.
int core_population(int tribe);
double core_mana_max(void);
// Sets a tribe's mana, clamped to [0, max]. For tests and scenario setup.
void core_mana_set(int tribe, double mana);

// How many spells there are, and each one's fixed rules: mana, spent when the
// cast lands; how far from the shaman its target may be, in world units along
// the surface; seconds to cast; seconds before the tribe may cast it again;
// and the angular radius in radians of the disc it writes (for a bridge, of
// each stamp along it). 0 for a bad spell.
int core_spell_count(void);
double core_spell_cost(int spell);
double core_spell_range(int spell);
double core_spell_cast_seconds(int spell);
double core_spell_cooldown_seconds(int spell);
double core_spell_radius(int spell);

// Whether `tribe`'s shaman could cast `spell` at (x, y, z): 0 yes, otherwise
// the reason. (ox, oy, oz) is a Land Bridge's near end; all zero is wherever
// she stands. The disc spells ignore it. Changes nothing.
int core_spell_check(
    int spell, int tribe, double x, double y, double z, double ox, double oy, double oz);
// The same check; on 0 she stops and starts casting, ending any cast already
// under way. Any other result changes nothing.
int core_spell_cast(
    int spell, int tribe, double x, double y, double z, double ox, double oy, double oz);
// Ends `tribe`'s cast in progress, if any, with nothing spent.
void core_spell_cancel(int tribe);

// Spell progression. Every spell starts unlocked; `at` 0 unlocks it for the
// tribe now, -1 locks it for the match, and a positive `at` locks it until
// the tribe's population first reaches that many. A locked spell is refused
// with 12, by the player's casts and the AI's alike. Ignores a bad tribe or
// spell.
void core_spell_set_unlock(int tribe, int spell, int at);
// The threshold as it stands: 0 unlocked, -1 never, or the population still
// to reach. -1 for a bad tribe or spell.
int core_spell_unlock_at(int tribe, int spell);

// The spell `tribe` is casting now, or -1; how far through it is, 0..1; and
// where it will land: 4 floats, a unit direction and the disc's angular
// radius, zeros when not casting. Valid until the next call.
int core_spell_casting(int tribe);
double core_spell_progress(int tribe);
float* core_spell_target(int tribe);
// Seconds before `tribe` may cast `spell` again; 0 when it may.
double core_spell_cooldown(int tribe, int spell);

// How `tribe`'s most recent cast ended: how many have ended so far (goes up
// by one each time), which spell, and the result — 0 it landed.
int core_spell_ended(int tribe);
int core_spell_ended_spell(int tribe);
int core_spell_ended_result(int tribe);

// What the last Land Bridge to land laid: core_land_bridge_stamp_count()
// stamps of 3 floats (a unit direction) each, every one
// core_spell_radius(0) across; and the height above sea level the stamps
// raise the centre line to.
int core_land_bridge_stamp_count(void);
float* core_land_bridge_stamps(void);
double core_land_bridge_height(void);

// --- the match and the tribes the core plays ----------------------------
//
// A shaman killed by warriors is gone for good. Her tribe has fallen: its
// people are stopped and deselected, and no order call moves them again. The
// match is over once a shaman has fallen and at most one still stands.

// 1 once `tribe`'s shaman has been killed this match.
int core_shaman_fallen(int tribe);
// 1 once the match is decided; and the tribe whose shaman is left standing,
// or -1 while it goes on (or if the last two fell together).
int core_match_over(void);
int core_match_winner(void);

// Hands `tribe` to the core's AI, which every core_ai_think_seconds() does
// at most one thing for it through the same order and cast calls as above:
// cast a useful spell, build (flattening a pad first if it must), chop, train
// a warrior, or send its warriors at the enemy shaman. Its home is its first
// hut, or where its shaman stands. Returns 1, or 0 for a bad tribe or one
// with neither. It stops for good once the match is over.
int core_ai_enable(int tribe);
void core_ai_disable(int tribe);
int core_ai_enabled(int tribe);
// What the tribe's last think did — 0 waited, 1 cast a spell, 2 sent the
// shaman to the shore to bridge from, 3 built a hut, 4 flattened a pad, 5
// sent braves to chop, 6 sent a brave to train, 7 sent warriors to attack, 8
// sent braves home to breed (mirrors inkulous::AiAction) — how many thinks
// did something, and how many there have been.
int core_ai_last_action(int tribe);
int core_ai_actions(int tribe);
int core_ai_thinks(int tribe);
double core_ai_think_seconds(void);

// The weights `tribe`'s AI plays by (inkulous::AiPersonality): seconds
// between thinks, the huts it stops at, how far round home it builds and
// forages in world units, the fewest enemies a Swamp or Blast must catch (0
// never), idle warriors it gathers at home before marching, braves it keeps
// housed to breed, and whether it bridges (0 or 1). Each is clamped. Kept
// across core_ai_enable; core_world_clear puts the defaults back. Returns 1,
// or 0 for a bad tribe.
int core_ai_configure(int tribe,
                      double think_seconds,
                      int hut_cap,
                      double build_reach,
                      double forage_reach,
                      int patch,
                      int muster,
                      int settle,
                      int bridges);
// One weight as the AI holds it, in the order core_ai_configure takes them
// (0 think_seconds .. 7 bridges); 0 for a bad tribe or field.
double core_ai_personality(int tribe, int field);

#ifdef __cplusplus
}  // extern "C"
#endif
