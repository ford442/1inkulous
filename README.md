# 1inkulous
A Populous 3: The Beginning clone.

Rendering, input and UI are TypeScript on WebGPU. The simulation is C++ compiled
to WebAssembly, so the heavy work — pathfinding, AI, sphere maths — stays out of
the JS main thread.

```
src/engine/   WebGPU device, planet + follower meshes, renderer, picking, math
src/game/     planet + terrain heights, orbit camera, terrain brush, followers
src/input/    keyboard and pointer capture
src/sim/      typed bridge across the WebAssembly boundary
src/wasm/     build output (generated) + core.d.ts, the checked-in ABI contract
cpp/          simulation core: fixed-step clock, navigation graph, followers
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
| `npm run build` | WASM core, then `tsc`, then the production bundle |
| `npm run build:web` | Skips the WASM step; fails if `src/wasm/core.js` is absent |
| `npm run build:wasm` | Compiles `cpp/` into `src/wasm/core.js` + `core.wasm` |
| `npm run test:core` | Headless checks of the core in Node (no browser needed) |
| `npm run clean:wasm` | Removes the CMake build directory and generated artifacts |

`src/wasm/core.js` and `core.wasm` are generated and git-ignored;
`src/wasm/core.d.ts` is hand-written and tracked, so a change to the C ABI in
`cpp/include/1inkulous/core_abi.h` must be mirrored there.

The Emscripten glue targets `web,worker,node` — the Node environment is what lets
`npm run test:core` run in CI. That is why a production build prints one
informational notice about `node:module` being externalised for the browser; the
branch that would use it never executes there.

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
follower positions reach the renderer, and how the walkable graph and its
heights get in.

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
| Hold `C` + wheel, `[` `]` | Brush size, brush strength |

Shift-click toggles one follower; Shift-drag adds everyone in the box. A plain
drag replaces the selection, and a click that does not move stays a single
pick. Hold `C` to sculpt: the brush has first claim on the mouse while it is
held, so a sculpt stroke never also picks a follower or starts a selection box.
Right-drag orbits; a right-click that stays put still sends the selection.

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

**Terrain deformation is live.** The graph's topology is uploaded once; its
heights are a buffer in core memory that the game overwrites whenever a sculpt
stroke moves the ground. Raise a ridge across a walking follower's way and it
looks for another; if there is none, it gives up and stops where it stands.

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
is cheaper than a second pipeline.

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
- Followers are placeholder pawns. The opening village cycles the four
  placeholder tribe colours (blue, red, yellow, green); unique art comes later.

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
