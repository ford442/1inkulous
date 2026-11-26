import type { InputSnapshot, PointerClick } from '../input/input'
import type { Simulation } from '../sim/simulation'
import { createCamera, type Camera } from './camera'
import { createFollowers, type Followers } from './followers'
import { createGameEvents, type GameEvent } from './gameEvents'
import { createHuts, type Huts } from './huts'
import type { Planet } from './planet'
import { buildWorld, rebuildWorld, type BuildMode, type World } from '../world/build'
import { createMatch, type Match } from '../world/match'
import type { Scenario } from '../world/schema'
import { createSculptor, isSculptModifierHeld, type Sculptor } from './sculpt'
import { createShaman, type Shaman } from './shaman'
import { createSpellEvents, type SpellLanding } from './spellEffects'
import { createSun, type Sun } from './sun'
import type { Terrain } from './terrain'
import { createTrees, type Trees } from './trees'

export type Game = {
  clearColor: [number, number, number]
  planet: Planet
  /** The ground, owned by the core; the planet mesh is redrawn from it. */
  terrain: Terrain
  camera: Camera
  sculptor: Sculptor
  followers: Followers
  huts: Huts
  shaman: Shaman
  trees: Trees
  /** Who is playing whom, and how it is going. */
  readonly match: Match
  /** The world as built: its scenario, every tribe's home, and the explicit copy the editor works on. */
  readonly world: World
  /**
   * Builds `scenario` again on the same planet, everything but the ground
   * cleared and laid out afresh: the editor, after every change. The match
   * and the world above follow it. Throws for a planet of another size.
   */
  rebuild: (scenario: Scenario) => void
  /** Where the light comes from: riding with the camera, or a turning day. */
  sun: Sun
  /**
   * Spells that landed (either tribe's) since the last call, for the renderer
   * to turn into effects. Each is handed out once.
   */
  takeSpellLandings: () => SpellLanding[]
  /**
   * Everything that happened in the world since the last call — a chop, a hut
   * going up, a spell cast or landing, a death — for the speakers. Each is
   * handed out once, and by a drain of its own, so it does not compete with
   * `takeSpellLandings` for the same landings.
   */
  takeEvents: () => GameEvent[]
  /**
   * `aspect` is the viewport's width / height, needed to turn the cursor into a
   * world-space ray for terrain picking.
   */
  update: (deltaMs: number, input: InputSnapshot, aspect: number) => void
}

export type GameOptions = {
  /** The world to play: see src/world/schema.ts. */
  scenario: Scenario
  /**
   * Overrides the scenario's match seed: the scattered forest and every
   * random choice the core makes. The same seed and the same commands give
   * the same match, so this, with the command log, is all a bug report or a
   * replay needs.
   */
  seed?: number
  /** 'play' (default) or 'edit': the editor's world has no AI running. */
  mode?: BuildMode
  /** Every tribe on the AI, the player's too: for tests and demos. */
  allAi?: boolean
}

/**
 * `simulation` is the C++ core, taken at construction rather than reached for
 * later: the world it owns — the terrain, the navigation graph over it and
 * every follower standing on it — has to exist before the first frame.
 */
export function createGame(simulation: Simulation, options: GameOptions): Game {
  const scenario =
    options.seed === undefined ? options.scenario : { ...options.scenario, seed: options.seed >>> 0 }
  const buildOptions = { mode: options.mode ?? 'play', allAi: options.allAi ?? false } as const
  // The planet, the ground the core now owns, every tribe and the forest.
  // Its first command seeds the match, so it is the first thing a replay does.
  let world = buildWorld(simulation, scenario, buildOptions)
  const { planet, terrain } = world

  const camera = createCamera({
    planetRadius: planet.radius,
    maxTerrainHeight: planet.maxHeight,
  })

  const sculptor = createSculptor(terrain)
  // The world planted its own forest; this module is the glue for chop orders.
  const trees = createTrees(planet, simulation, { count: 0 })
  let match = createMatch(world, simulation)
  // The world spawned every tribe. The follower module is only the glue for
  // clicks: it spawns nobody of its own.
  const followers = createFollowers(terrain, simulation, {
    spawnCount: 0,
    shamanTribe: null,
    selectTribe: match.playerTribe,
  })
  const huts = createHuts(planet, simulation)
  const shaman = createShaman(planet, simulation)

  const sun = createSun()
  const tribes = world.tribes.map((tribe) => tribe.tribe)
  const spellEvents = createSpellEvents(simulation, tribes)
  let landings: SpellLanding[] = []
  const gameEvents = createGameEvents(simulation, { tribes, planetRadius: planet.radius })
  let events: GameEvent[] = []

  // Open on the player's tribe, or the first village there is. A home is
  // wherever the scenario or the flattest land put it, as likely behind the
  // planet as in front.
  const opening = match.playerHome ?? world.tribes.find((tribe) => tribe.home)?.home ?? null
  if (opening) {
    camera.focusOn(opening, true)
  }
  // An outcome decided by the clock or a headcount rather than a fallen
  // shaman: the world stops playing at the moment it was won.
  let decided = false

  const state = {
    clearColor: [0.04, 0.05, 0.09] as [number, number, number],
  }

  return {
    planet,
    terrain,
    camera,
    sculptor,
    followers,
    huts,
    shaman,
    trees,
    get match() {
      return match
    },
    get world() {
      return world
    },
    rebuild(next: Scenario) {
      const populated = rebuildWorld(simulation, terrain, next, buildOptions)
      world = { ...world, ...populated, scenario: next }
      match = createMatch(world, simulation)
      decided = false
      // Whatever the old world landed or said is not this one's.
      spellEvents.poll()
      gameEvents.poll()
      landings = []
      events = []
    },
    sun,
    takeSpellLandings() {
      const taken = landings
      landings = []
      return taken
    },
    takeEvents() {
      const taken = events
      events = []
      return taken
    },
    get clearColor() {
      return state.clearColor
    },
    update(deltaMs: number, input: InputSnapshot, aspect: number) {
      // While the brush is armed it owns drag and the wheel, so an edit never
      // swings the camera at the same time.
      const sculpting = isSculptModifierHeld(input)
      camera.update(deltaMs, input, {
        allowPointerOrbit: !sculpting,
        allowPointerZoom: !sculpting,
      })

      // After the camera, so picking uses the view that is about to be drawn.
      // The stroke edits the core directly, so a hut site judged or a path
      // searched later this frame already sees it.
      sculptor.update(deltaMs, input, { camera, aspect })

      // A spell being aimed sees the clicks first: a cast is not
      // also a hut, a selection or a move order. Then huts, which own the left
      // button in build mode so no selection box starts while placing, and a
      // right-click on a hut as an enter or eject order. Then trees, which
      // take a right-click on one as a chop order.
      const pointer = input.pointer
      const without = (taken: ReadonlySet<PointerClick>): InputSnapshot =>
        taken.size === 0
          ? input
          : {
              ...input,
              pointer: {
                ...pointer,
                clicks: pointer.clicks.filter((click) => !taken.has(click)),
              },
            }
      const aimed = shaman.update(deltaMs, input, { camera, aspect })
      const housed = huts.update(deltaMs, without(aimed.consumed), { camera, aspect })
      const chopped = trees.update(
        deltaMs,
        without(new Set([...aimed.consumed, ...housed.consumed])),
        { camera, aspect },
      )
      const claimed = new Set<PointerClick>([
        ...aimed.consumed,
        ...housed.consumed,
        ...chopped.consumed,
      ])
      const placing = aimed.targeting || housed.building
      const forFollowers: InputSnapshot =
        claimed.size === 0 && !placing
          ? input
          : {
              ...input,
              pointer: {
                ...pointer,
                clicks: pointer.clicks.filter((click) => !claimed.has(click)),
                drags: placing ? [] : pointer.drags,
                dragRect: placing ? null : pointer.dragRect,
              },
            }

      // Followers ignore clicks and selection drags that overlapped C, so a
      // sculpt stroke is filtered out on the gesture itself, not only by the
      // `sculpting` flag above.
      followers.update(deltaMs, forFollowers, { camera, aspect })

      sun.update(deltaMs, input, camera.eye)
      // Capped, so a backgrounded tab that comes back to a dozen landings
      // does not keep them all; the renderer drains this every frame.
      landings = [...landings, ...spellEvents.poll()].slice(-16)
      // The same, for sound: capped so a long-backgrounded tab does not replay
      // a crowd's worth of chopping when it returns.
      events = [...events, ...gameEvents.poll()].slice(-64)

      if (!decided && match.outcome !== 'playing') {
        decided = true
        for (const tribe of world.tribes) {
          if (simulation.aiEnabled(tribe.tribe)) {
            simulation.disableAi(tribe.tribe)
          }
        }
      }

      // Last: whatever moved the ground this frame — the brush, a spell, the
      // core's own steps before this update — reaches the mesh before drawing.
      terrain.syncMesh()
    },
  }
}
