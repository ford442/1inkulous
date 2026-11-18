import type { Vec3 } from '../engine/math'
import { AiAction } from '../sim/ai'
import { HutKind, HutSite } from '../sim/hutSite'
import type { Simulation } from '../sim/simulation'
import { Spell } from '../sim/spell'
import { findSpawnNodes } from './followers'
import type { NavGraph } from './navGraph'
import { PLAYER_TRIBE } from './shaman'
import { MAX_WALKABLE_SLOPE, type Terrain } from './terrain'

/**
 * The match: two shamans on one planet.
 *
 * `createMatch` is the one place a match is laid out. The player's tribe
 * starts on the flattest land, as it always has. Tribe 1 — red — gets a
 * shaman, a dwelling on a pad flattened for it and a handful of braves on the
 * flattest land well round the planet from the player, preferring a site the
 * player could walk to. The core's AI is handed tribe 1 and plays it with the
 * same orders and casts the player has. Tribes 2 and 3 are not used.
 *
 * Killing the other shaman wins; losing your own loses. There is no
 * reincarnation yet, so the first shaman to fall ends it.
 */

export const ENEMY_TRIBE = 1

export const TRIBE_NAMES: readonly string[] = ['Blue', 'Red', 'Yellow', 'Green']

const PLAYER_FOLLOWERS = 24
const ENEMY_BRAVES = 10
/** Enemy home at least this far round the planet from the player's, in radians. */
const MIN_APART = 1.2
/** Sites tried for a walking route from the player before the flattest is taken anyway. */
const ROUTE_TRIES = 40
/** Trees each village is sure of within this many radians, planted if the forest left it short. */
const GROVE_ANGLE = 0.3
const GROVE_TREES = 4

export type MatchOptions = {
  playerFollowers?: number
  enemyBraves?: number
  /** Hand tribe 1 to the core's AI. Defaults to true. */
  enemyAi?: boolean
}

export type MatchOutcome = 'playing' | 'won' | 'lost' | 'draw'

/** The enemy tribe as the HUD reports it. */
export type TribeReadout = {
  readonly tribe: number
  readonly name: string
  readonly shamanStanding: boolean
  readonly population: number
  readonly mana: number
  readonly income: number
  readonly wood: number
  readonly action: AiAction
}

export type Match = {
  readonly playerTribe: number
  readonly enemyTribe: number
  /** Where the player's village grew from; the opening view looks at it. Null on a planet with no land. */
  readonly playerHome: Vec3 | null
  /** The enemy dwelling's direction; null when nowhere would take it. */
  readonly enemyHome: Vec3 | null
  readonly outcome: MatchOutcome
  readonly enemy: TribeReadout
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))))

function nodeDirection(graph: NavGraph, node: number): Vec3 {
  const d = graph.directions
  const length = Math.hypot(d[node * 3], d[node * 3 + 1], d[node * 3 + 2])
  return [d[node * 3] / length, d[node * 3 + 1] / length, d[node * 3 + 2] / length]
}

function mean(graph: NavGraph, nodes: readonly number[]): Vec3 | null {
  let x = 0
  let y = 0
  let z = 0
  for (const node of nodes) {
    x += graph.directions[node * 3]
    y += graph.directions[node * 3 + 1]
    z += graph.directions[node * 3 + 2]
  }
  const length = Math.hypot(x, y, z)
  return length > 0 ? [x / length, y / length, z / length] : null
}

/**
 * Dry nodes two links in from any water, so a hut's footprint and the ring
 * under its walls are on land, ranked flattest first.
 */
function inlandByFlatness(graph: NavGraph, heights: Float32Array, planetRadius: number): number[] {
  const { nodeCount, neighborOffsets, neighbors } = graph
  const dryAround = (node: number) => {
    for (let link = neighborOffsets[node]; link < neighborOffsets[node + 1]; link += 1) {
      if (heights[neighbors[link]] <= 0) {
        return false
      }
    }
    return true
  }
  const scored: { node: number; slope: number }[] = []
  for (let node = 0; node < nodeCount; node += 1) {
    if (heights[node] <= 0 || !dryAround(node)) {
      continue
    }
    let inland = true
    let slope = 0
    const here = nodeDirection(graph, node)
    for (let link = neighborOffsets[node]; link < neighborOffsets[node + 1]; link += 1) {
      const next = neighbors[link]
      if (!dryAround(next)) {
        inland = false
        break
      }
      const run = angleBetween(here, nodeDirection(graph, next)) * planetRadius
      if (run > 0) {
        slope = Math.max(slope, Math.abs(heights[next] - heights[node]) / run)
      }
    }
    if (inland && slope <= MAX_WALKABLE_SLOPE) {
      scored.push({ node, slope })
    }
  }
  scored.sort((a, b) => a.slope - b.slope)
  return scored.map((entry) => entry.node)
}

/** Tops a village's surroundings up to `GROVE_TREES` trees, so its braves have wood to fetch. */
function plantGrove(simulation: Simulation, graph: NavGraph, home: Vec3, spread: readonly number[]) {
  const data = simulation.treeInstances()
  const stride = simulation.treeInstanceFloats
  let near = 0
  for (let id = 0; id < data.length / stride; id += 1) {
    const at: Vec3 = [data[id * stride], data[id * stride + 1], data[id * stride + 2]]
    const length = Math.hypot(...at)
    if (angleBetween(home, [at[0] / length, at[1] / length, at[2] / length]) < GROVE_ANGLE) {
      near += 1
    }
  }
  // From the outside of the village in, so the trees stand round it, not in it.
  for (let i = spread.length - 1; i >= 0 && near < GROVE_TREES; i -= 1) {
    if (simulation.plantTree(nodeDirection(graph, spread[i])) >= 0) {
      near += 1
    }
  }
}

/**
 * Lays out the match on the planet the terrain already holds: both villages,
 * the enemy's dwelling, a grove each if the forest left one short, and the
 * enemy AI switched on. Plant the forest first: the enemy's pad clears any
 * tree it lands on.
 */
export function createMatch(
  terrain: Terrain,
  simulation: Simulation,
  options: MatchOptions = {},
): Match {
  const { graph, planet } = terrain
  const playerTribe = PLAYER_TRIBE
  const enemyTribe = ENEMY_TRIBE

  // --- the player's village: flattest land, the shaman in the middle --------
  const playerNodes = findSpawnNodes(
    graph,
    terrain.heights(),
    planet.radius,
    (options.playerFollowers ?? PLAYER_FOLLOWERS) + 1,
  )
  if (playerNodes.length > 0) {
    simulation.spawnShaman(nodeDirection(graph, playerNodes[0]), playerTribe)
    for (const node of playerNodes.slice(1)) {
      simulation.spawnFollower(nodeDirection(graph, node), playerTribe)
    }
  }
  const playerHome = mean(graph, playerNodes)

  // --- the enemy's site: flat, far, and walkable to if any such is ----------
  let enemyHome: Vec3 | null = null
  let enemyNodes: number[] = []
  if (playerHome) {
    const far = inlandByFlatness(graph, terrain.heights(), planet.radius).filter(
      (node) => angleBetween(nodeDirection(graph, node), playerHome) >= MIN_APART,
    )
    const walkable = far
      .slice(0, ROUTE_TRIES)
      .filter(
        (node) =>
          simulation.module._core_nav_route(...playerHome, ...nodeDirection(graph, node), 0) >= 0,
      )
    const flattenAngle = simulation.spellRadius(Spell.flatten)
    for (const node of [...walkable, ...far]) {
      const site = nodeDirection(graph, node)
      // Levelled here by the scenario itself, not cast: nobody pays for it.
      terrain.flatten(site, flattenAngle, terrain.heightAt(site), 1)
      if (simulation.hutSite(site, HutKind.dwelling, enemyTribe).site !== HutSite.ok) {
        continue
      }
      const door: Vec3 = [
        playerHome[0] - site[0] * dot(playerHome, site),
        playerHome[1] - site[1] * dot(playerHome, site),
        playerHome[2] - site[2] * dot(playerHome, site),
      ]
      if (simulation.placeHut(site, door, enemyTribe, HutKind.dwelling) < 0) {
        continue
      }
      enemyHome = site
      // Round the pad, never on it: a hut's footprint blocks standing.
      const footprint = simulation.hutSite(site).footprint
      enemyNodes = findSpawnNodes(
        graph,
        terrain.heights(),
        planet.radius,
        (options.enemyBraves ?? ENEMY_BRAVES) + 1,
        {
          start: node,
          skip: (n) => angleBetween(nodeDirection(graph, n), site) <= footprint * 1.05,
        },
      )
      break
    }
  }
  if (enemyHome && enemyNodes.length > 0) {
    simulation.spawnShaman(nodeDirection(graph, enemyNodes[0]), enemyTribe)
    for (const node of enemyNodes.slice(1)) {
      simulation.spawnFollower(nodeDirection(graph, node), enemyTribe)
    }
    plantGrove(simulation, graph, enemyHome, enemyNodes)
    if (options.enemyAi ?? true) {
      simulation.enableAi(enemyTribe)
    }
  } else {
    console.warn('[match] nowhere on the planet would take the enemy village; playing alone')
  }
  if (playerHome) {
    plantGrove(simulation, graph, playerHome, playerNodes)
  }

  return {
    playerTribe,
    enemyTribe,
    playerHome,
    enemyHome,
    get outcome() {
      return matchOutcome(simulation, playerTribe)
    },
    get enemy() {
      return {
        tribe: enemyTribe,
        name: TRIBE_NAMES[enemyTribe],
        shamanStanding: simulation.shamanId(enemyTribe) >= 0,
        population: simulation.population(enemyTribe),
        mana: simulation.mana(enemyTribe),
        income: simulation.manaIncome(enemyTribe),
        wood: simulation.wood(enemyTribe),
        action: simulation.aiLastAction(enemyTribe),
      }
    },
  }
}

/** Where the match stands for `playerTribe`. Pure over the core's answers. */
export function matchOutcome(
  simulation: Pick<Simulation, 'matchOver' | 'matchWinner'>,
  playerTribe: number,
): MatchOutcome {
  if (!simulation.matchOver) {
    return 'playing'
  }
  const winner = simulation.matchWinner
  return winner < 0 ? 'draw' : winner === playerTribe ? 'won' : 'lost'
}
