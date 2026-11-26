import { PERSONALITY_NAMES, SCENARIO_FORMAT, parseScenario, type Scenario, type TribeSpec } from './schema'

/**
 * A world from nothing but a seed: the procedural skirmish.
 *
 * The terrain is the core's generator with parameters drawn from the seed, and
 * so are the number of rivals (one to three), their personalities, and the
 * rules. Drawn from a generator of its own (xorshift, like the core's), never
 * `Math.random`, so a seed is a world: `?random=1234` is the same planet on
 * every machine, and a seed is all a player needs to share one.
 */

function generator(seed: number) {
  let state = (seed >>> 0) || 0x2545f491
  const next = () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state
  }
  for (let i = 0; i < 4; i += 1) next()
  return {
    /** [0, 1), 24 bits: the same on every engine. */
    unit: () => (next() >>> 8) / 16777216,
    /** [low, high], whole. */
    whole: (low: number, high: number) => low + (next() % (high - low + 1)),
  }
}

const RIVAL_NAMES = ['Reedfolk', 'Cinder Clan', 'Mirewalkers', 'Stonebinders', 'Ashen Host', 'Gullwings']

/** Two places is plenty for a parameter; a seed's world still prints tidily. */
const two = (x: number) => Math.round(x * 100) / 100

export function skirmishWorld(seed: number): Scenario {
  const random = generator(seed)
  const rivals = random.whole(1, 3)
  const tribes: TribeSpec[] = [{ tribe: 0, name: 'Kindred', control: 'player', braves: 18 }]
  const names = [...RIVAL_NAMES]
  for (let i = 1; i <= rivals; i += 1) {
    const name = names.splice(random.whole(0, names.length - 1), 1)[0]!
    tribes.push({
      tribe: i,
      name,
      control: 'ai',
      // Not the gentlest: a skirmish is for someone who has played the campaign.
      ai: PERSONALITY_NAMES[random.whole(1, PERSONALITY_NAMES.length - 1)]!,
      braves: random.whole(8, 14),
      huts: [{ kind: 'dwelling' }],
    })
  }
  return parseScenario({
    format: SCENARIO_FORMAT,
    id: `random-${seed >>> 0}`,
    name: `Random world ${seed >>> 0}`,
    description: `A world drawn from the seed ${seed >>> 0}: ${rivals} rival${rivals === 1 ? '' : 's'}, every spell, last shaman standing.`,
    seed: seed >>> 0,
    planet: {
      resolution: 24,
      terrain: {
        kind: 'generated',
        seed: random.whole(0, 0xffffff),
        land: two(0.38 + 0.17 * random.unit()),
        continents: random.whole(1, 4),
        continentSize: two(0.6 + 0.5 * random.unit()),
        continentWeight: two(0.45 + 0.3 * random.unit()),
        warp: two(0.15 + 0.35 * random.unit()),
        ridges: two(0.5 * random.unit()),
        relief: 1.25 + 0.25 * random.whole(0, 4),
      },
    },
    trees: { scatter: random.whole(120, 200), groves: 4 },
    tribes,
    rules: {
      victory: [{ kind: 'conquest' }],
      placement: { apart: rivals === 1 ? 1.2 : 0.9 },
    },
  })
}
