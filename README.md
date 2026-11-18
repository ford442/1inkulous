# 1inkulous
A Populous 3: The Beginning clone.

Rendering, input and UI are TypeScript on WebGPU. The simulation is C++ compiled
to WebAssembly, so the heavy work — pathfinding, AI, sphere maths — stays out of
the JS main thread.

```
src/engine/   WebGPU device, planet + follower meshes, renderer, picking, math
src/engine/shaders/   the WGSL, one file per pipeline, imported as source
src/game/     planet mesh view, terrain hand-off, orbit camera, brush, followers, huts, trees
src/input/    keyboard and pointer capture
src/sim/      typed bridge across the WebAssembly boundary
src/wasm/     build output (generated) + core.d.ts, the checked-in ABI contract
cpp/          simulation core: fixed-step clock, terrain, navigation graph, followers, huts, trees, wood, tribe AI
```

## Prerequisites

- **Node** 20 or newer
- **CMake** 3.20 or newer
- **Emscripten SDK**, with `emcc` and `emcmake` on `PATH`

The simulation core is not optional: the app fails to start without it, and every
build script that needs `emcc` stops with install instructions rather than
skipping the core silently.

Install the SDK once:

```sh
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
```

Then activate it in each shell — add it to your shell profile so `npm` scripts
inherit it:

```sh
source /path/to/emsdk/emsdk_env.sh
emcc -v   # confirm
```

## Build and run

| Command | What it does |
| --- | --- |
| `npm run dev` | Builds the WASM core, then starts the Vite dev server |
| `npm run dev:web` | Dev server only — fast path when `src/wasm/` is already current |
| `npm run dev:debug` | Builds the debug core, then serves it (see [Debug build](#debug-build)) |
| `npm run build` | WASM core, then `tsc`, then the production bundle |
| `npm run build:web` | Skips the WASM step; fails if `src/wasm/core.js` is absent |
| `npm run build:wasm` | Compiles `cpp/` into `src/wasm/core.js` + `core.wasm` (release) |
| `npm run build:wasm:debug` | Opt-in `-O0 -g -sASSERTIONS=2` core, in its own directory |
| `npm test` | Every `test:*` script below, one after another, with a summary. This is what CI runs |
| `npm run test:abi` | `core_abi.h`, `core.d.ts` and the exports in `core_abi.cpp` agree; needs no build |
| `npm run test:core` | Headless checks of the core in Node (no browser needed) |
| `npm run test:select` | Rubber-band selection and the pointer gestures behind it |
| `npm run test:huts` | Hut picking and build mode against a fake core; then placing, entering, breeding and routing round a hut on the real core and planet |
| `npm run test:shaman` | Shaman, mana and the four spells — cast, cancelled, short of mana, cooling down, and one enemy shaman — first on the core alone (no planet module), then aimed and cast through the game module |
| `npm run test:terrain` | The core owns the ground: the brush moves core, graph, feet and mesh together, and a pick agrees with a path |
| `npm run test:economy` | Chopping, what huts cost, eject, training a warrior and a kill: on the core alone, then through the game modules |
| `npm run test:ai` | The enemy tribe on its own: on a flat core with a few planted trees it chops, builds, trains a warrior and sends him at the player's shaman; bridges a strait only when it can pay; swamps a crowd but not its own people; then a shaman killed by a warrior ending the match, her people deaf to orders and the AI stopped; and the match the game opens on |
| `npm run test:memory` | The core's heap holds the opening village and a full tribe without growing, and the module declares a ceiling |
| `npm run test:gpu` | Drawing-buffer sizing, limit planning, GPU error reporting and loss messages, and what the renderer's source must keep true |
| `npm run clean:wasm` | Removes the CMake build directories and generated artifacts |

`npm test` finds the `test:*` scripts in `package.json` itself, so a new one is
run — locally and in CI — without being listed anywhere else. `npm test -- core
huts` runs just those.

`src/wasm/core.js` and `core.wasm` are generated and git-ignored;
`src/wasm/core.d.ts` is hand-written and tracked, so a change to the C ABI in
`cpp/include/1inkulous/core_abi.h` must be mirrored there. `npm run test:abi`
is what notices when it is not: it fails on a function declared in one and
missing from the other, on a different argument count or `void`-ness, and on a
declaration `core_abi.cpp` does not export.

The Emscripten glue targets `web,worker,node` — the Node environment is what lets
`npm run test:core` run in CI. That is why a production build prints one
informational notice about `node:module` being externalised for the browser; the
branch that would use it never executes there.

### The release core

`npm run build:wasm` links `-O3 -flto`, with `-fno-rtti -fno-exceptions` (nothing
in `cpp/` uses either, so a stray `throw` is a build error). Linear memory is
sized rather than left to grow: 32 MB to start, 128 MB at most. The build prints
what the binary declares, read back out of the `.wasm`:

```
wasm core (Release) written to src/wasm/  (108K core.wasm, memory 32MB initial, 128MB maximum)
```

A full tribe (`kMaxFollowers`) all sent across the default planet, huts and all,
peaks around 3 MB; `npm run test:memory` watches that it never grows the heap.
Growth stays enabled so a bigger planet still loads, but the ceiling means a
leak — or a planet raised past what the numbers were sized for — aborts at a
stack trace instead of swelling the tab. The footprint scales with the planet's
node count (resolution 48 is about 8 MB, 96 about 29 MB, 160 about 80 MB), so
raise `CORE_INITIAL_MEMORY` and `CORE_MAXIMUM_MEMORY` in `cpp/CMakeLists.txt` on
purpose when the planet grows. Pthreads are off, so no COOP/COEP headers are
needed. `-msimd128` was tried and left off: it did not move route or step times
on the 3600-node graph outside noise.

### Debug build

`npm run build:wasm:debug` compiles `-O0 -g -sASSERTIONS=2` into
`cpp/build-wasm-debug/out/`: its own build directory and its own output, so it
can neither overwrite the release core in `src/wasm/` nor be picked up by
`npm run dev`. Point the tools at it with `CORE_WASM_DIR`:

```sh
npm run dev:debug                                  # build it, then serve it
CORE_WASM_DIR=cpp/build-wasm-debug/out npm test    # or run the tests against it
```

The time budgets in `test:core` (a mass order inside a frame, and so on) are
claims about the release build; against a core loaded this way they are printed
but not enforced.

## Rendering

The frame is drawn into 4x multisampled colour and depth targets and resolved to
the canvas, so the planet's limb and the instanced pawns do not shimmer as the
camera moves. Around that:

- **Device.** `src/engine/webgpu.ts` asks for the high-performance adapter and
  falls back to the default one. When neither exists, or the browser has no
  WebGPU at all, the page says so in a sentence instead of a stack trace. The
  adapter and its limits are logged at startup. Limits are requested only where
  the frame needs more than WebGPU guarantees (today it does not, so none are),
  and no optional features are. If the GPU cannot meet a need, startup says
  which.
- **Canvas.** Opaque: the canvas is the whole frame. Its tone mapping is left
  alone, because the shaders apply their own exposure curve
  (`1 - exp(-1.35 * color)`) and a second one on top would wash it out.
- **Resolution.** The canvas is laid out at 1024x768 CSS pixels and its drawing
  buffer follows `devicePixelRatio`, capped at 2: 2048x1536 on a 2x display. It
  is checked every frame, so zooming the page or moving the window to another
  monitor resizes it. Input and picking never leave CSS pixels.
- **Failure.** If the GPU device is lost the frame loop stops and the HUD is
  replaced with what happened and a Reload button. A GPU validation error is
  logged once per distinct message rather than every frame.
- **Shaders** are plain `.wgsl` files in `src/engine/shaders/`, imported with
  Vite's `?raw`. The renderer keeps pipeline creation.

## The JS/WASM boundary

TypeScript owns rendering; C++ owns simulation. They meet at one call:

```ts
const simulation = await createSimulation()   // src/sim/simulation.ts
simulation.tick(deltaMs)                      // once per frame
```

`tick` hands the frame's elapsed time to the core, which consumes whole fixed
steps (50ms, 20Hz) so simulation behaviour does not depend on frame rate, and
returns how many ran. A long stall is capped rather than replayed in a burst.

Only scalars cross the boundary per frame. Bulk state is read directly out of
the module's linear memory (`simulation.module.HEAPF32` and friends, exported
for exactly this) rather than marshalled through call arguments — that is how
follower positions reach the renderer, how the walkable graph gets in, and how
the terrain heights come back out to the mesh.

## Controls

| Input | Does |
| --- | --- |
| Right-drag | Orbit the planet |
| Wheel | Zoom |
| `1`–`4` | Cardinal views |
| `0`, `Home`, middle-click | Reset the view |
| `WASD` / arrows, `Q`/`E` | Orbit and zoom from the keyboard |
| Drag a box | Select every on-screen follower inside it |
| Shift-drag a box | Add those followers to the selection |
| Click a follower | Select it |
| Shift-click a follower | Add to (or drop from) the selection |
| Click bare ground | Clear the selection |
| Right-click | Send the selected followers walking there |
| Hold `C` + left / right drag | Raise / lower terrain |
| Hold `C` + Shift + left drag | Flatten terrain to the height where the stroke began |
| `B` | Build mode: place a hut (`B`, `Esc` or right-click cancels) |
| `T` | Build mode: place a training hut (`T`, `Esc` or right-click cancels; `B` switches) |
| Click, in build mode | Build there, if the site is good and the tribe has the wood (Shift keeps placing) |
| Right-click a hut | Send the selected braves inside |
| Right-click your hut, nothing selected | Send everyone inside back out |
| Right-click a tree | Send up to three of the selected braves to chop it |
| Hold `C` + wheel, `[` `]` | Brush size, brush strength |
| `F` | Select the shaman and centre the view on her |
| `L` | Aim a Land Bridge (`L`, `Esc`, `B` or right-click puts it away) |
| `X` / `V` / `M` | Aim Blast / Flatten / Swamp (the same key, `Esc`, `B` or right-click puts it away; another spell's key switches) |
| Click, while aiming | Cast there: a disc spell on the click, a bridge from the shaman to it (Shift keeps aiming) |
| Drag, while aiming a bridge | Raise land from where the drag began to where it ends |
| Order the shaman, while she casts | Cancels the cast; so does casting another spell |

Shift-click toggles one follower; Shift-drag adds everyone in the box. A plain
drag replaces the selection, and a click that does not move stays a single
pick. Hold `C` to sculpt: the brush has first claim on the mouse while it is
held, so a sculpt stroke never also picks a follower or starts a selection box.
Right-drag orbits; a right-click that stays put still sends the selection.
Build mode owns the left button while it is on, so placing a hut never starts
a selection box; C still wins over it, so a pad can be flattened without
leaving build mode.

## Followers

The first units on the planet. They live entirely inside the C++ core — their
positions, their paths, the A* search behind an order, and the steering that
keeps a group from piling up — and TypeScript only builds the graph they walk,
turns clicks and box drags into orders, and draws them.

**The walkable graph is the planet mesh's welded vertex grid.** One node per
distinct surface position, linked 8 ways within each cube face. Choosing the
*welded* vertices is what makes the sphere tractable: the six faces meet at
seams where duplicate vertices already share a weld id, so linking through the
weld table stitches the faces together and a path can walk off the edge of one
face onto the next without any face-adjacency table. See `src/game/navGraph.ts`.

**The core owns the terrain.** Nav nodes are the welded vertices, so the
core's one float per node *is* the ground. On load `createTerrain`
(`src/game/terrain.ts`) uploads the graph's topology and seeds those heights
from the generated field — the only time TypeScript writes walkable height.
After that every edit is a core call: `Terrain::sculpt` and `Terrain::flatten`
(`cpp/src/terrain.cpp`) for the brush, the same calls from inside the core for
a spell. Each edit widens a dirty node range; once a frame `syncMesh` copies
those nodes onto every mesh vertex sharing their weld id, and the renderer
uploads the touched vertex range as it always has. Picking reads height from
the core on the same triangle a walker uses, so a click lands where a path
does. Raise a ridge across a walking follower's way and it looks for another;
if there is none, it gives up and stops where it stands.

**A step is refused above a slope of 0.55** — height change over arc length, a
shade under 30 degrees — and water is never walkable. Path cost is the true
length over the ground, so a detour round a hill can beat climbing it, while the
A* heuristic ignores climb and therefore stays admissible. A diagonal link is
only taken when its whole quad is good ground, so a route never cuts the corner
of a pond or the foot of a cliff.

**Routes are string-pulled.** A* over the grid gives a staircase of nodes; the
core then pulls it tight, jumping from each waypoint to the furthest later one
it can see along the great circle, so open ground is crossed in one straight
leg and a detour hugs the corners it has to. "Can see" means every point of the
leg stands on good ground: the core reads the terrain under a point as the
triangle of the nearest node's fan that holds it, and a corner carrying more
than a sliver of weight has to be land and within a step's slope of the
others. Routes are held to that strictly (2% of the weight); each step a
walker takes is held to it loosely (15%), which covers anything the line test
could miss between its samples, so a leg it was given is always one it can
walk. See `NavGrid::smooth_path` and `NavGrid::clear_line` in `cpp/src/nav.cpp`.

**Positions are free, not snapped to nodes.** A follower is a direction on the
sphere plus its height, read off that same triangle, so its feet follow the
ground between nodes. Each fixed step has three passes (`FollowerSet::step` in
`cpp/src/followers.cpp`):

1. *Steer.* A walker heads for its next waypoint. Someone ahead of it and
   close to its line, standing or coming the other way, gets stepped round —
   always to the side they are not on, so a head-on pair passes. Someone
   walking the same way is followed at a spacing instead. Within a couple of
   spacings of a corner it looks past it every quarter second, so a crowd
   rounds a corner instead of queueing for the exact point.
2. *Separate.* Anyone closer than the spacing (0.024 on the unit planet, a
   gap's worth wider than a pawn) is pushed apart, half each — except that a
   walker never yields to someone standing still. The bystander shuffles
   aside if the ground lets it; if it is pinned, the walker squeezes past.
3. *Settle.* Everyone's feet go back on the ground, which may have been
   sculpted under them.

Both neighbour queries share one hash of follower positions, rebuilt by a sort
every step.

**A group order gives everyone a spot.** The click's point becomes the middle
of a hex packing a shade wider than the spacing, laid out over ground the goal
connects to. The group's routes come from one Dijkstra out from the goal rather
than one A* each; each follower's route is that, then out along the flood to
its own spot. Spots fill from the far side back — far along the way the routes
actually arrive, not along the straight line from home — so nobody pushes
through the ones who got there first.

**Stuck is handled in layers.** A walker blocked by the ground slides along it
before re-routing, and re-routes at most three times without reaching a
waypoint, eight stalls per order in all, before it gives up. One held up in a
crowd waits up to 20 seconds per stall before that counts, and one stopped at
the edge of its own formation has arrived.

**Rendering is one instanced draw**, however many followers there are. The core
keeps a packed instance buffer (position, heading, tribe, flags); the renderer
copies it out of linear memory once per frame and draws the whole tribe in a
single call. The selection ring is part of the same mesh and collapses to a
degenerate point in the vertex shader when the follower is not selected, which
is cheaper than a second pipeline. A follower's role rides in the same flags
word, from bit 3 up (`kRoleShift`), and a warrior's bone-white headband and
club are two more parts of that mesh that collapse the same way on a brave.

`core_nav_route` and `core_follower_route` copy a route — raw or smoothed, or
what a follower has left to walk — into a scratch buffer, for tests and for a
debug overlay later. They are a view: TypeScript never keeps a copy of a path.

### Cost

Measured by `npm run test:core` on a graph the size of the real one (3600 nodes,
~28000 links, against the default planet's 3458 and ~26000):

- A 60-follower order across the diagonal of the world: **5–7 ms** — one
  search covering the whole patch, a formation, and a string-pull with a line
  test the length of the world for every follower. It happens on a click, not
  per frame; on the real planet a typical order is 1–6 ms.
- Stepping 60 walking followers out of one stack: **~0.1 ms** per fixed step,
  20 times a second. On the real planet the HUD's `sim` slice stays at
  0.1–0.2 ms per frame with the whole village on the move.

So the simulation is not the constraint at this scale; the render side is one
extra draw call and a 2 KB buffer upload per frame. The HUD's fps line averages
those three slices over half a second (`sim` is `tick`, `game` is input/sculpt/
orders, `draw` is the CPU side of the WebGPU encode).

Most of an order is the line tests. Most of a step is the neighbour queries
and reading the ground under each follower, both linear in the population.

### Not done yet

- A narrow pass takes a crowd a while: they queue through it a few abreast.
  Across 90 random 60-follower orders on the default planet, about 99% stand
  in formation at the end and none are left walking, but the slowest order
  took nearly two minutes.
- String-pulled corners sit exactly on the obstacle's corner node, so a crowd
  converges on one point there; offsetting corners by the spacing would widen
  the stream.
- Avoidance is reactive (look ahead, step aside), not velocity-obstacle
  planning, so two crowds crossing still jostle where they meet.
- Followers are placeholder pawns in the placeholder tribe colours (blue,
  red, yellow, green); unique art comes later. A match uses blue and red (see
  [The match](#the-match)).

## Huts

The first game loop, as in the original: flatten a pad, drop a hut, send
people in, and the hut breeds more. One structure owns every building —
placement, kind, tribe, door, occupants, breeding, training and the nodes it
stands on. It lives in the C++ core next to the followers
(`cpp/src/huts.cpp`); TypeScript runs build mode, picks huts under the cursor
and draws them (`src/game/huts.ts`). There are two kinds, on the same site
and footprint rules: the dwelling described here (B), and the training hut
(T) in [Wood, trees and warriors](#wood-trees-and-warriors).

**A hut stands on a nav node, and its footprint is that node and its
neighbours.** Placing snaps to the node nearest the click. Every footprint
node has to be dry, and the footprint nodes plus sixteen samples of the
ground under the walls (on the wall and halfway in) may differ by no more than
0.0025 between highest and lowest — about 4% of the tallest terrain, so a
slope gentle enough to walk is still not a floor. A footprint may not overlap
or touch another hut's, which leaves at least one free node between two huts:
a lane to walk. On the default planet little land passes as it is, so most
huts start with the flatten brush: hold C and Shift and drag, and
the ground under the brush is pulled level with wherever the stroke began. It
is the core's `Terrain::flatten`, the sibling of `sculpt`, so builders and
spells in the core can use it too. A pad levels in a fraction of a second at default strength.

In build mode the brush disc becomes the hut's footprint — it reaches the
furthest footprint node, the same patch that has to be level and that the hut
will block — green where the core would build and red where it would not, with
a see-through ghost of the hut on the snapped node and the reason on the HUD
(water, too uneven, too close to another hut, not enough wood). The door
faces the camera. Placing never sculpts.

**Huts cost wood.** A tribe's first dwelling is free, so the opening village
can build before anyone has felled a tree; every one after costs 10 wood,
and a training hut 15. The core judges the price with the site: a site the
ground would take but the stockpile cannot pay for is refused, nothing is
spent, and the ghost shows red with the price on the HUD. A hut placed
unclaimed through the core (no tribe) is free. `core_huts_clear` gives the
free hut back.

**Huts block walking.** Once a hut stands, its footprint nodes are blocked in
`NavGrid`, and `walkable()` — which path search, string-pulling (`clear_line`)
and the loose ground test of every step all read — refuses them exactly as it
refuses water. A route to the far side goes round, a diagonal does not cut
the pad, and anyone walking when a hut goes up is routed again. A follower
standing on the pad when the hut appears is set down on the nearest free node.
Sculpting under a standing hut carries it with the ground; the footprint stays
blocked.

**Going in.** Right-click a hut with followers selected and the nearest
braves among them walk to it, as many as it has room for (three) once anyone
already on the way is counted. It is an ordinary group move to the hut's door, round the
pad, with the hut remembered on each follower, so formation and avoidance work
as they do for any order. A hut placed with B belongs to the player's tribe,
and only that tribe goes in (one placed unclaimed through the core belongs to
the first tribe sent to it). The shaman and warriors never go in. A follower that comes
within reach — the ring of free nodes round the pad, and a body's width more —
goes inside: it leaves the follower set and becomes one of the hut's
occupants. One that stops short, or gets another order, drops the enter
order.

**Breeding.** A hut with people in it breeds one follower per 30
occupant-seconds — one birth every 30 seconds with one inside, every 10 with
three. Newborns step out of the door and stand there; separation spreads them
out. The occupants stay inside. The HUD's population line counts everyone,
outside and in.

**Coming out.** Right-click one of your own huts with nobody selected and
everyone inside steps back out of the door as braves (`core_hut_eject`),
the reverse of going in. They rejoin the follower set, so they stop when it
reaches `kMaxFollowers`; whoever does not fit stays inside. Emptying a
training hut lets the trainee out a brave again and puts the wood back.

**Rendering is one more instanced draw**: the core keeps a packed hut buffer
(position, heading, tribe, occupants, kind) beside the follower one. The roof
takes the owning tribe's colour, and the door glows once someone lives
there. A training hut is the same mesh drawn taller and narrower, in dark
timber under a slate roof. The ghost is one more instance on the end of that
buffer, drawn blended, with the kind being placed.

### Not done yet

- Sculpting under a hut moves it with the ground rather than damaging it.
- Paths go round a pad corner to corner; there is no corner offset or
  velocity-obstacle steering yet, so a crowd hugs the footprint.
- No upgrades, and only the one training building.

## Wood, trees and warriors

The first match economy: a brave gathers, a hut breeds, a training hut
spends wood and a person to make someone who can fight. All of it is in the
core; TypeScript turns clicks into orders and draws the buffers.

**Wood is one number per tribe**, in the core's `Stockpile`
(`cpp/include/1inkulous/tribes.hpp`), shown on the HUD beside mana. It
starts at nothing. Only buildings spend it.

**Trees.** At match start the core scatters 140 trees over dry land above
the shore — walkable nodes with no water next door — from the heights it
already owns (`TreeSet::spawn`, `cpp/src/trees.cpp`), keeping a node clear
round each, chosen by a seeded generator so a match starts the same way
twice. A tree is a point, not an obstacle, with a packed instance buffer of
its own (position, heading, size, chop progress) and one more instanced
draw. A hut raised over a tree clears it, and ground sculpted under the sea
drowns it; neither gives wood.

**Chopping.** Right-click a tree with braves selected and up to three of the
nearest walk to it, each to its own spot a spacing out round the trunk, with
the tree remembered on them the way a hut is. Within 0.05 of the trunk a
brave chops: four brave-seconds fell a tree, so three together take under
two. The tree leans over as the chop goes on, then leaves the set, and its 5
wood go to the tribe of whoever landed the last blow. Any other order drops
the chop; one that stops short drops it too. Warriors and the shaman do not
chop.

**Roles.** Every follower has one (`Role` in `followers.hpp`): brave, the
default, or warrior. The shaman stays a flag on a brave. A role changes
only constants (`kRoleStats`): a warrior walks 25% faster and strikes; a
brave does neither.

**Training.** Send a brave into a training hut while the tribe has 5 wood.
The wood is paid at the door, the brave is consumed, and eight seconds later
a warrior steps out. It holds one at a time, and turns a brave away while
the tribe cannot pay.

**Combat** is the smallest thing that makes the role matter. Every fixed
step, after everyone has moved, each warrior strikes the nearest enemy
follower within 0.04 of it for 20 health a second — five seconds to cut down
someone alone, whatever their role. All the blows of a step land together,
and anyone at zero health is taken out of the set (`FollowerSet::fight`). No
chasing, formations, ranged attacks or fire: move warriors next to an enemy
and they fight.

`npm run test:economy` checks all of it on the core alone — a forest planted
and replanted from a seed, a tree chopped by one brave and by three, the free
first hut and the refused second, an eject, a warrior trained and a kill —
and then the same orders through the game modules with synthetic clicks.

### Not done yet

- A brave fells one tree and stops; nobody looks for the next one, and the
  wood arrives without being carried home.
- Warriors do not seek out enemies or answer an attack, and nobody fights
  back but other warriors.
- No preachers, firewarriors, spies, boats, balloons or guard towers; no
  vault of knowledge.
- No chopping or striking animation: a timer, a lean, and a removed
  instance.

## The shaman and her spells

One special unit and four spells, and the spells only work because the world
already has live heights and a walkable graph.

**The shaman is a follower with a flag.** She spawns at the heart of the
opening village, on top of its 24 braves, as the player's (blue) tribe's
shaman: `kFlagShaman` in the instance buffer, drawn taller and in a pale robe
over her tribe colour. Everything else — selecting, box selection, move
orders, avoidance — is the follower code, unchanged. She never goes into a
hut. Ids shift as followers go inside, so the core looks her up by tribe
(`core_shaman`) instead of anyone keeping her number.

**Mana is one number per tribe.** Every fixed step each tribe gains
`population × 1` mana per second, counting followers outside and occupants
inside huts, up to 1000. The HUD shows the player's mana and current income.

**Every spell goes through one path.** A spell is an id (`Spell` in
`cpp/include/1inkulous/shaman.hpp`), and there are two calls:
`Shamans::check(spell, tribe, target)` says whether it would go ahead and, if
not, why; `Shamans::cast(spell, tribe, target)` runs the same check and, if it
passes, starts the cast. The player's keys reach them through
`core_spell_check` / `core_spell_cast`; the enemy tribe's AI calls the same
two from inside the core (see [The match](#the-match)). Each spell's cost,
range, cast time, cooldown and radius are one row of `kSpellRules`, not
anything the input code knows:

| Spell | Key | Mana | Radius | Cast | Cooldown | Does |
| --- | --- | --- | --- | --- | --- | --- |
| Land Bridge | `L` | 200 | 0.09 a stamp | 1s | 3s | Raises a strip along the great circle between two points |
| Blast | `X` | 200 | 0.1 | 1s | 4s | Raises a hill 0.02 high, the way the brush does, and throws everyone standing on it out past the rim |
| Flatten | `V` | 150 | 0.16 | 1s | 3s | Pulls the disc to the height at its centre: a pad `B` accepts, even for a click a little off it |
| Swamp | `M` | 250 | 0.12 | 1.5s | 5s | Drops the disc to sea level, so its nodes are water and routes go round |

Every target must be within 0.3 of her (a few cells), and a bridge's both
ends. A cast takes its cast time: she stops where she stands and carries
`kFlagCasting` (her robe goes gold) while the disc pulses on the ground where
it will land, a ring closing in from the rim. A move order, a second cast or
being pushed out of range ends it early with nothing spent. When the time is
up the check runs again on the world as it is then — the ground may have
changed, the mana may have gone — and only if it still passes is the mana
spent, the cooldown started and the ground written, by the core, through
`Terrain::sculpt` and `Terrain::flatten`. No TypeScript runs to finish a
cast, the graph is never rebuilt, and the mesh picks the change up from the
dirty range at the end of the frame. A refused or cancelled cast spends
nothing and writes no height. The terrain edits have dry runs
(`Terrain::would_sculpt`, `would_flatten`), which is how a check tells
"nothing to do" without touching the ground.

What each spell asks of the target, in `Shamans::judge`:

- **Land Bridge**: at least one end ashore — dry, or within 0.1 of walkable
  land, in which case it is pulled onto that land so the bridge lands rather
  than stopping short (one end at sea is a pier; two are refused) — and the
  line must cross water, sampled a fraction of a cell at a time with the same
  weight rule routes use. It lands as stamps half a stamp apart along the
  line, each lifting its centre to the crest (0.01 above sea level) and doing
  nothing where the ground is already higher. The stamps stay readable for
  drawing and tests.
- **Blast**: something to raise, or someone to throw. Anyone inside the disc
  is set down a body's width past its rim, straight away from the centre, on
  that point if it can be stood on and on the nearest walkable node if not;
  anyone walking is routed again from there.
- **Flatten**: a centre above water (a pad at sea level is a swamp), and
  ground that is not level already.
- **Swamp**: ground that is not water already. A follower caught on it is set
  down on the nearest dry node and stops; anyone walking a route over it is
  routed round, or stopped if there is no longer a way.

While aiming, the cursor disc marks the spell's disc — a bridge's far end at
the strip's width — green where the core would cast it and red where it would
not. The HUD's spell row lists every spell's key, name and cost, the seconds
one has left to rest, a cast under way, and for the spell being aimed, the
go-ahead or the reason it is red (short of mana, out of range, nothing to do,
under water, still resting).

`npm run test:shaman` checks all of this twice. First on the core alone —
topology and a flat seed in, a moat dug with the core's sculpt, every spell
refused, started, landed and walked over, a cast cancelled by an order, by a
second cast and by being thrown out of range, one that runs out of mana
before it lands, and a held key bouncing off the cooldown — with no planet
module at all. Then through the game module: the keys, the clicks and drags,
the HUD row, a cancel, and the mesh matching the core after each cast.

### Not done yet

- Reincarnation, spell unlocks and the vault. A shaman's death ends the match.
- Lightning, swarm, earthquake, erode, volcano, hypnotise, angel of death.
  Lightning wants the damage path; it comes once warriors can die from
  something other than a warrior.
- Spells are sculpted earth like any other, so the brush can undo them, and
  followers standing on a bridge's path are lifted with the ground. Blast
  moves the people it throws in one step, not along an arc; there are no
  particles — the height change is the effect.
- Swamp does not spare huts: one standing in the disc keeps its footprint
  blocked on ground that is now water.
- No line-of-sight rule.

## The match

Two shamans on one planet. `createMatch` in `src/game/scenario.ts` is the one
place a match is laid out, on the placeholder noise planet:

- **Blue, the player**: the shaman and 24 braves on the flattest land. The
  camera opens on them, and only blue can be clicked or boxed into the
  selection.
- **Red, tribe 1**: a shaman and 10 braves round a dwelling on the flattest
  land at least 1.2 rad round the planet, preferring a site the player could
  walk to. The scenario levels the pad itself (no mana) and plants a few trees
  round each village if the forest left one short. Red's mana rises with its
  population like blue's; the HUD's red line shows its people, mana, wood and
  what its AI did last.
- Yellow and green are unused.

**The AI is in the core** (`TribeAi`, `cpp/include/1inkulous/tribe_ai.hpp`),
and it does not run every 50 ms step: every 2 s, for each tribe handed to it
(`core_ai_enable`), it does at most one thing, the first of:

1. If the shaman is idle and a spell is legal and useful, cast it. **Land
   Bridge** only when water cuts the tribe's warriors off from the enemy
   shaman: a flood fill from a warrior finds his landmass, the shore nearest
   the enemy is the near end, and the first foreign land along the line, within
   the spell's range, is the far end. If she is out of range she first walks to
   that shore. If the tribe cannot pay, she does neither. **Swamp**, else
   **Blast**, centred on the enemy with the most other enemies round them
   (three or more) in her range, never with one of her own people or her huts
   in the disc.
2. If the wood allows and there are fewer than four huts, build: a training hut
   first if there is none (the free first dwelling excepted), otherwise a
   dwelling, on the nearest level site within 0.35 of home. With none level,
   she **Flattens** the nearest uneven site she can reach, clear of every hut,
   and the hut goes up on a later think. That is the only time she flattens.
3. If braves are idle and trees stand within 0.6 of home, send them to chop.
   One is kept back when a training hut could take him, or chopping would keep
   every hand busy.
4. If a training hut has room and the wood allows, send a brave in.
5. If warriors are idle, send them at the nearest enemy shaman. The ordinary
   group order is the attack move: they strike whoever they pass, and every
   think resends the idle ones to where she is now.

Every one of these is the call the player's input reaches: `Shamans::cast`,
`HutSet::place`, `HutSet::order_enter`, `TreeSet::order_chop` and
`FollowerSet::order_move`. The enter and chop orders take an id list, and the
player's selection versions now build that list and call them.

**A shaman can die** from warrior damage like anyone else. When she does, her
tribe has fallen (`core_shaman_fallen`): its people stop and drop out of the
selection, and no order call (move, enter, chop, eject) moves them again. The
match is over once a shaman has fallen and at most one still stands
(`core_match_over`, `core_match_winner`). The HUD shows who fell and whether
that is a win or a loss, and the AI stops thinking.

### Not done yet

- Reincarnation, the stone head and a timer to bring her back. Death is final.
- Personalities, difficulty, more than one enemy, and the rest of the solar
  system.
- Boats and balloons. Land Bridge is the only crossing, so a red village across
  an ocean too wide to bridge never reaches the player.
- Red's dwellings are never filled, so red does not grow: braves become
  warriors until it runs out of braves or wood.
- Pathfinding for armies. Warriors walk as one ordinary group order.

## Design notes

The brainstorming conversation that started the project:


I have an idea for a new game - 1inkulous - we remake populous-3 in a web wasm webgpu context redoing all of the graphics/sounds/animations as like a clone :)

That sounds like an incredible project! Populous: The Beginning (Populous 3) is an absolute classic, and bringing that unique spherical-world RTS gameplay into the modern era is a fantastic concept.

Rebuilding it for the browser is highly ambitious but entirely feasible with today's web technologies. Here is a breakdown of why your tech stack is a great fit, along with a few major challenges you will want to prepare for.

Why Your Tech Stack is Perfect
WebGPU: This is the real game-changer here. The original game relied heavily on real-time terrain deformation (raising/lowering land, volcanoes, earthquakes). WebGPU's compute shaders will allow you to handle complex terrain mesh updates and massive particle systems for spells with incredible efficiency directly in the browser.

WebAssembly (WASM): RTS games are CPU-intensive. You have to handle pathfinding for hundreds of followers, enemy AI, and constant state updates. Writing your core logic in a performance-heavy language (like C++, Rust, or Zig) and compiling to WASM will give you the near-native performance you need to keep the simulation running smoothly at 60+ FPS.

The Asset Overhaul (Graphics, Sounds, Animations)
Redoing all the assets is arguably the most labor-intensive part of a clone, but it gives you total creative freedom.

Visual Style: You can decide whether to keep the charming, low-poly, chunky aesthetic of the 1998 original but with modern lighting (PBR materials, dynamic shadows), or go for a completely high-fidelity, realistic look.

Animations: Modern skeletal animation blending will make the followers and shamans look much more lifelike when transitioning between chopping wood, praying, and fighting.

Key Challenges to Anticipate
Spherical Mathematics: The defining feature of Populous 3 is playing on a globe. Pathfinding (A*), line-of-sight calculations, and grid-based building placement are notoriously difficult on a sphere compared to a flat plane. You will likely need to implement an icosphere or a subdivided cube-sphere logic.

Intellectual Property (IP): Since Electronic Arts (EA) owns the Populous IP, you will need to make sure "1inkulous" is a spiritual successor rather than a 1:1 direct rip-off. You can recreate the mechanics, but you must create 100% original art, sound, lore, and names to stay legally safe.

The Shaman's AI: Coding the enemy Shamans to intelligently build bases, gather mana, and strategically cast spells against the player is a complex AI programming challenge.

It is a massive undertaking, but the god-game genre is ripe for a web-based revival. What programming language or framework are you thinking of using for the core logic before compiling it down to WASM (e.g., Rust with Bevy, C++ with Emscripten, or something else)?

ok. i would want to keep faithful to the game's maps/scale/mechanics for fans of the original. ideas about the name?

Staying hyper-faithful to the original scale and mechanics is exactly what the Populous: The Beginning community wants. The "Retro HD" treatment — modern engine, identical gameplay — is highly successful for classic RTS games.

Just a quick word of caution: while game mechanics cannot be copyrighted, level layouts and specific character designs can be. If you recreate the original 25 solar system maps 1:1, you risk a cease-and-desist from EA. You can keep the feel and scale identical, but you should scramble the exact topography just enough to be legally distinct.

Regarding the name, "1inkulous" is a fun working title, but for a public release, you want something that evokes the nostalgic feel of the original without triggering trademark algorithms.

Here are a few naming angles that signal to fans exactly what the game is, while keeping you legally safe:

The "Synonym" Approach
These names play on the word "Populous" (meaning heavily populated) but use different words, winking at the fans.

Multitude

The Populace

Myriad: The Beginning

Legion's Dawn

The Shaman & Tribe Focus
Populous 3 broke away from the traditional "God Game" by putting a physical Shaman on the battlefield. These names lean into that core mechanic.

Shaman's Path

The Matriarch

Mana Sphere

Tribal Genesis

The World & Shape Focus
The most iconic part of the game was the wrapping spherical planets. These names highlight the unique map structure.

Firmament

Aetheria

Orbitus RTS

Hemisphere

If you want to keep your "1ink" branding, you could use a subtitle structure like 1ink presents: Firmament or Multitude (A 1ink Engine Game).

Want to brainstorm how to handle the spherical map mathematics in WASM?

Yes

how to start up the first repo structure to use probably js and ts with npm and then add c++ later

Setting up the repository correctly from day one is crucial, especially when you are planning a hybrid architecture where TypeScript handles the rendering (WebGPU) and UI, while C++ eventually handles the heavy simulation logic (WASM).

The best tool for this modern web stack is Vite. It is incredibly fast, supports TypeScript natively, and has excellent plugins for handling WebAssembly when you are ready to introduce C++.

Here is a step-by-step guide to laying the foundation for your engine.

1. Initialize the Project
Open your terminal and use npm with Vite to scaffold a vanilla TypeScript project.

Bash
npm create vite@latest 1inkulous -- --template vanilla-ts
cd 1inkulous
npm install
2. The Ideal Hybrid Directory Structure
Once Vite generates the base files, you will want to restructure it to prepare for a game engine scale. Create the folders so your project looks like this:

Plaintext
1inkulous/
├── public/              # Static files served directly (not bundled)
│   ├── models/          # 3D meshes
│   ├── textures/        # Albedo, normal maps, etc.
│   └── audio/           # Sound effects and music
├── src/                 # TypeScript Frontend & WebGPU
│   ├── engine/          # WebGPU initialization, shaders, pipelines
│   ├── game/            # Game state sync (talking to WASM later)
│   ├── ui/              # HTML/CSS HUD and Menus
│   ├── input/           # Mouse, keyboard, and camera controls
│   └── main.ts          # Main entry point
├── cpp/                 # 🚀 Your C++ Core (Staging for later)
│   ├── src/             # C++ source (pathfinding, AI, sphere math)
│   ├── include/         # C++ headers
│   └── CMakeLists.txt   # Build config (for Emscripten later)
├── index.html           # Main HTML canvas container
├── package.json         # NPM dependencies and scripts
├── tsconfig.json        # TypeScript configuration
└── vite.config.ts       # Bundler config (you will add WASM support here)
3. Why This Structure Works
Strict Separation of Concerns: By isolating src/ (TypeScript) and cpp/ (C++), you prevent the two ecosystems from getting tangled. The browser handles what it does best (graphics, input, audio), and C++ handles what it does best (raw CPU number-crunching).

The WASM Bridge: When you are ready to write C++, you will use Emscripten (emcc). Emscripten will compile the code in your cpp/ folder and output a .wasm binary file and a .js "glue" file. You will instruct Emscripten to drop those built files directly into your public/ or src/ directory, where your TypeScript code can fetch and instantiate them.

Vite Configuration: You will eventually create a vite.config.ts file in the root. When the time comes, you can easily add plugins like vite-plugin-wasm to handle the asynchronous loading of your C++ module.

This gives you a clean sandbox to start building out your WebGPU triangle-rendering today, with a clear home for your C++ logic tomorrow.
