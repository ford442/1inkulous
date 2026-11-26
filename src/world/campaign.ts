import * as v from 'valibot'
import { browserStorage, type SettingsStorage } from '../audio/settings'
import { readScenario, type Scenario } from './schema'

/**
 * The shipped worlds and the player's way through them.
 *
 * `public/worlds/index.json` lists the campaign — its worlds in order, each
 * teaching one thing — and every world is its own scenario file beside it,
 * `public/worlds/<id>.json`. The game boots from one of those files.
 *
 * Progress is the set of worlds won, kept in `localStorage` under a versioned
 * key. Like the sound settings (src/audio/settings.ts), storage may throw or
 * hold anything, so every read is guarded and sanitised: what is not a known
 * world's id is dropped, and a campaign that cannot remember still plays from
 * the first world. A world is open once the one before it is won.
 */

export const CatalogSchema = v.strictObject({
  format: v.literal(1),
  campaign: v.strictObject({
    name: v.pipe(v.string(), v.minLength(1)),
    worlds: v.pipe(
      v.array(
        v.strictObject({
          id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,47}$/)),
          /** What this world teaches, for the menu. */
          teaches: v.pipe(v.string(), v.maxLength(120)),
        }),
      ),
      v.minLength(1),
    ),
  }),
})
export type Catalog = v.InferOutput<typeof CatalogSchema>

export function parseCatalog(value: unknown): Catalog {
  const result = v.safeParse(CatalogSchema, value)
  if (!result.success) {
    throw new Error(`worlds/index.json is not a world catalogue: ${result.issues.map((i) => i.message).join('; ')}`)
  }
  const ids = result.output.campaign.worlds.map((world) => world.id)
  if (new Set(ids).size !== ids.length) {
    throw new Error('worlds/index.json lists a world twice')
  }
  return result.output
}

// --- progress -----------------------------------------------------------------

export const CAMPAIGN_KEY = '1inkulous.campaign.v1'

export type Progress = {
  /** Ids of the campaign worlds won, in campaign order. */
  readonly won: readonly string[]
}

/** Anything at all, made into progress through `catalog`: unknown ids dropped. */
export function sanitizeProgress(value: unknown, catalog: Catalog): Progress {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const raw = Array.isArray(source.won) ? source.won : []
  const known = new Set(raw.filter((id): id is string => typeof id === 'string'))
  return { won: catalog.campaign.worlds.map((world) => world.id).filter((id) => known.has(id)) }
}

export function loadProgress(catalog: Catalog, storage: SettingsStorage | null = browserStorage()): Progress {
  if (!storage) {
    return { won: [] }
  }
  try {
    const text = storage.getItem(CAMPAIGN_KEY)
    return sanitizeProgress(text === null ? null : JSON.parse(text), catalog)
  } catch {
    return { won: [] }
  }
}

/** Records `id` as won and keeps it. Returns the new progress, kept or not. */
export function recordWin(
  catalog: Catalog,
  progress: Progress,
  id: string,
  storage: SettingsStorage | null = browserStorage(),
): Progress {
  const next = sanitizeProgress({ won: [...progress.won, id] }, catalog)
  try {
    storage?.setItem(CAMPAIGN_KEY, JSON.stringify(next))
  } catch {
    // Remembering is a courtesy: the win still counts for this visit.
  }
  return next
}

export type WorldStanding = {
  readonly id: string
  readonly teaches: string
  /** 1-based place in the campaign. */
  readonly chapter: number
  readonly won: boolean
  /** Open to play: the first world, or one after a world won. */
  readonly open: boolean
}

export function standings(catalog: Catalog, progress: Progress): WorldStanding[] {
  const won = new Set(progress.won)
  return catalog.campaign.worlds.map((world, i) => ({
    id: world.id,
    teaches: world.teaches,
    chapter: i + 1,
    won: won.has(world.id),
    open: i === 0 || won.has(catalog.campaign.worlds[i - 1]!.id) || won.has(world.id),
  }))
}

/** The world to start on: the first open one not yet won, else the last. */
export function nextWorld(catalog: Catalog, progress: Progress): string {
  const open = standings(catalog, progress).filter((world) => world.open)
  return (open.find((world) => !world.won) ?? open[open.length - 1] ?? standings(catalog, progress)[0]!).id
}

/** The campaign world after `id`, or null after the last (or outside it). */
export function worldAfter(catalog: Catalog, id: string): string | null {
  const worlds = catalog.campaign.worlds
  const at = worlds.findIndex((world) => world.id === id)
  return at >= 0 && at + 1 < worlds.length ? worlds[at + 1]!.id : null
}

// --- fetching -----------------------------------------------------------------

/** Where the shipped worlds are served from, beside the page. */
export const WORLDS_PATH = 'worlds/'

type Fetch = typeof fetch
const pageBase = () => (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/')

export async function fetchCatalog(fetchFn: Fetch = (...a) => fetch(...a), base = pageBase()): Promise<Catalog> {
  const response = await fetchFn(new URL(`${WORLDS_PATH}index.json`, base).href)
  if (!response.ok) {
    throw new Error(`worlds/index.json: ${response.status} ${response.statusText}`)
  }
  return parseCatalog(await response.json())
}

export async function fetchWorld(id: string, fetchFn: Fetch = (...a) => fetch(...a), base = pageBase()): Promise<Scenario> {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) {
    throw new Error(`"${id}" is not a world id`)
  }
  const response = await fetchFn(new URL(`${WORLDS_PATH}${id}.json`, base).href)
  if (!response.ok) {
    throw new Error(`worlds/${id}.json: ${response.status} ${response.statusText}`)
  }
  return readScenario(await response.text(), `worlds/${id}.json`)
}

// --- the editor's hand-off ----------------------------------------------------

/**
 * A world the editor hands to a play-test, or a play-test back to the
 * editor: kept in the session's storage (a new tab starts clean) under one
 * key, as the scenario's own text.
 */
export const DRAFT_KEY = '1inkulous.draft.v1'

export function sessionStore(): SettingsStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function saveDraft(text: string, storage: SettingsStorage | null = sessionStore()): boolean {
  try {
    storage?.setItem(DRAFT_KEY, text)
    return storage !== null
  } catch {
    return false
  }
}

export function loadDraft(storage: SettingsStorage | null = sessionStore()): Scenario | null {
  try {
    const text = storage?.getItem(DRAFT_KEY) ?? null
    return text === null ? null : readScenario(text, 'the editor\'s draft')
  } catch (error) {
    console.warn('[world] the editor\'s draft would not load', error)
    return null
  }
}
