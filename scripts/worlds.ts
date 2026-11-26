/**
 * The shipped worlds as the Node tests read them: straight off disk from
 * public/worlds/, through the same parser the browser uses.
 */
import { readFileSync } from 'node:fs'
import { parseCatalog, type Catalog } from '../src/world/campaign.ts'
import { readScenario, type Scenario } from '../src/world/schema.ts'

export const WORLDS_DIR = new URL('../public/worlds/', import.meta.url)

/** The world a fresh visit opens on: the campaign's first. */
export const OPENING_WORLD = 'ember-shoal'

export function shippedCatalog(): Catalog {
  return parseCatalog(JSON.parse(readFileSync(new URL('index.json', WORLDS_DIR), 'utf8')))
}

export function shippedWorld(id: string): Scenario {
  return readScenario(readFileSync(new URL(`${id}.json`, WORLDS_DIR), 'utf8'), `worlds/${id}.json`)
}

/** The world the game opens on, as the tests that used to build "the opening match" want it. */
export const openingWorld = (): Scenario => shippedWorld(OPENING_WORLD)
