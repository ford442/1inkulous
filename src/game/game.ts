import type { InputSnapshot, PointerClick } from '../input/input'
import type { Simulation } from '../sim/simulation'
import { createCamera, type Camera } from './camera'
import { createFollowers, type Followers } from './followers'
import { createHuts, type Huts } from './huts'
import { createPlanet, type Planet } from './planet'
import { createMatch, type Match } from './scenario'
import { createSculptor, isSculptModifierHeld, type Sculptor } from './sculpt'
import { createShaman, type Shaman } from './shaman'
import { createSpellEvents, type SpellLanding } from './spellEffects'
import { createSun, type Sun } from './sun'
import { createTerrain, type Terrain } from './terrain'
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
  match: Match
  /** Where the light comes from: riding with the camera, or a turning day. */
  sun: Sun
  /**
   * Spells that landed (either tribe's) since the last call, for the renderer
   * to turn into effects. Each is handed out once.
   */
  takeSpellLandings: () => SpellLanding[]
  /**
   * `aspect` is the viewport's width / height, needed to turn the cursor into a
   * world-space ray for terrain picking.
   */
  update: (deltaMs: number, input: InputSnapshot, aspect: number) => void
}

/**
 * The seed a match starts from unless told otherwise: the forest the game has
 * always opened on.
 */
export const DEFAULT_MATCH_SEED = 1

export type GameOptions = {
  /**
   * Seeds the core's random generator before anything draws from it. The same
   * seed and the same commands give the same match, so this, with the command
   * log, is all a bug report or a replay needs.
   */
  seed?: number
}

/**
 * `simulation` is the C++ core, taken at construction rather than reached for
 * later: the world it owns — the terrain, the navigation graph over it and
 * every follower standing on it — has to exist before the first frame.
 */
export function createGame(simulation: Simulation, options: GameOptions = {}): Game {
  // First, so it is the first thing a replay of this match does.
  simulation.seedMatch(options.seed ?? DEFAULT_MATCH_SEED)
  const planet = createPlanet()
  // The planet generated the land; from here on the core owns it.
  const terrain = createTerrain(planet, simulation)

  const camera = createCamera({
    planetRadius: planet.radius,
    maxTerrainHeight: planet.maxHeight,
  })

  const sculptor = createSculptor(terrain)
  // Once, from the heights the core now owns: the forest the match starts with.
  // Before the match, so the enemy's pad clears whatever tree it lands on.
  const trees = createTrees(planet, simulation)
  // Both villages, the enemy's hut and its AI. The follower module is then
  // only the glue for clicks: it spawns nobody of its own.
  const match = createMatch(terrain, simulation)
  const followers = createFollowers(terrain, simulation, {
    spawnCount: 0,
    shamanTribe: null,
    selectTribe: match.playerTribe,
  })
  const huts = createHuts(planet, simulation)
  const shaman = createShaman(planet, simulation)

  const sun = createSun()
  const spellEvents = createSpellEvents(simulation, [match.playerTribe, match.enemyTribe])
  let landings: SpellLanding[] = []

  // Open on the player's tribe. The starting village is wherever the flattest
  // land turned out to be, which is as likely to be behind the planet as in front.
  if (match.playerHome) {
    camera.focusOn(match.playerHome, true)
  }

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
    match,
    sun,
    takeSpellLandings() {
      const taken = landings
      landings = []
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

      // Last: whatever moved the ground this frame — the brush, a spell, the
      // core's own steps before this update — reaches the mesh before drawing.
      terrain.syncMesh()
    },
  }
}
