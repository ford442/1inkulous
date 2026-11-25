import { parseGltf } from './gltf'
import {
  MANIFEST,
  type AssetGroup,
  type AssetKind,
  type AssetKindValue,
  type AssetManifest,
} from './manifest'

/**
 * Loads what the manifest lists: one place that fetches, reports progress,
 * remembers what it has fetched, and decides what a missing file means.
 *
 * - **Progress.** Bytes as they stream in, over everything requested so far;
 *   the loading screen reads it through `onProgress`.
 * - **Caching.** A loaded asset is kept and handed back to every later `load`;
 *   two callers asking for the same one at once share one request. The HTTP
 *   cache sits under that as usual (files in `public/` are not content-hashed,
 *   so how long they live is the host's cache headers' decision).
 * - **Optional versus required.** An optional asset that is absent — a 404, or
 *   a dev server answering a missing file with its page — or will not parse is
 *   `null`, with one line in the console, and the caller keeps its built-in.
 *   A required one throws an `AssetError` that says which file and why.
 * - **Cancelling.** An `AbortSignal` stops the request. An aborted load is not
 *   a failure and is not remembered as one: asking again starts it afresh.
 *
 * No DOM beyond `fetch`, which is injectable, so the whole of it runs in Node.
 */

export class AssetError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AssetError'
  }
}

export type AssetProgress = {
  /** 0..1 over everything requested so far; 1 when nothing is outstanding. */
  readonly fraction: number
  readonly loadedBytes: number
  /** What the responses (or the manifest) said, summed; 0 when nothing said. */
  readonly expectedBytes: number
  /** Assets that have finished, found or not. */
  readonly done: number
  readonly requested: number
  /** Keys still in flight. */
  readonly active: readonly string[]
}

export type AssetStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'failed'

type Loaders = {
  [K in AssetKind]: (bytes: ArrayBuffer, key: string) => AssetKindValue[K] | Promise<AssetKindValue[K]>
}

export type AssetManagerOptions = {
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** What relative manifest URLs resolve against. Defaults to the page's base. */
  baseUrl?: string
  /** How many requests may be in flight at once. */
  concurrency?: number
  /**
   * What is actually there, by manifest URL, with sizes: `assets-index.json`
   * (scripts/assets-index.mjs). When given, an optional asset that is not listed
   * is missing without a request, and a listed one's size is known up front.
   * Null (or omitted) means no index: each asset is simply asked for.
   */
  index?: Readonly<Record<string, number>> | null
  /** Overrides how a kind of asset is turned into its value. */
  loaders?: Partial<Loaders>
  /** Where the one-line notes go. Defaults to the console. */
  log?: { info: (message: string) => void; warn: (message: string) => void }
}

/** The value `load` resolves to: null only for an asset the manifest marks optional. */
export type AssetValue<M extends AssetManifest, K extends keyof M> =
  | AssetKindValue[M[K]['kind']]
  | (M[K] extends { readonly optional: true } ? null : never)

export type AssetManager<M extends AssetManifest> = {
  load: <K extends keyof M & string>(key: K, signal?: AbortSignal) => Promise<AssetValue<M, K>>
  /** Everything in a group (the whole manifest when none is named). */
  loadGroup: (group?: AssetGroup, signal?: AbortSignal) => Promise<void>
  /** A loaded asset, or null if it is not (yet, or ever) loaded. Never starts a load. */
  get: <K extends keyof M & string>(key: K) => AssetValue<M, K> | null
  status: (key: keyof M & string) => AssetStatus
  readonly progress: AssetProgress
  /** Called after every change to `progress`; returns a function that stops it. */
  onProgress: (listener: (progress: AssetProgress) => void) => () => void
}

type Entry =
  | { status: 'loading'; promise: Promise<unknown> }
  | { status: 'ready'; value: unknown }
  | { status: 'missing' | 'failed' }

type Tally = { loaded: number; expected: number; weight: number; finished: boolean }

const DEFAULT_CONCURRENCY = 6

const defaultLoaders: Loaders = {
  model: (bytes) => parseGltf(bytes),
  audio: (bytes) => bytes,
  binary: (bytes) => bytes,
}

function defaultBaseUrl(): string {
  return typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function createAssetManager<M extends AssetManifest>(
  manifest: M,
  options: AssetManagerOptions = {},
): AssetManager<M> {
  const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const baseUrl = options.baseUrl ?? defaultBaseUrl()
  const loaders: Loaders = { ...defaultLoaders, ...options.loaders }
  // An absent optional asset is the normal case, not news: debug, not info.
  const log = options.log ?? { info: (m) => console.debug(m), warn: (m) => console.warn(m) }
  const index = options.index ?? null
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)

  const entries = new Map<string, Entry>()
  const tallies = new Map<string, Tally>()
  const listeners = new Set<(progress: AssetProgress) => void>()

  // A plain counting gate, so a manifest of fifty files does not open fifty
  // connections.
  let running = 0
  const waiting: (() => void)[] = []
  const acquire = (): Promise<void> =>
    running < concurrency
      ? ((running += 1), Promise.resolve())
      : new Promise<void>((resolve) => waiting.push(resolve))
  const release = () => {
    const next = waiting.shift()
    if (next) {
      next()
    } else {
      running -= 1
    }
  }

  const snapshot = (): AssetProgress => {
    let loaded = 0
    let expected = 0
    let done = 0
    let weightSum = 0
    let weighted = 0
    const active: string[] = []
    for (const [key, tally] of tallies) {
      loaded += tally.loaded
      expected += tally.expected
      weightSum += tally.weight
      if (tally.finished) {
        done += 1
        weighted += tally.weight
      } else {
        active.push(key)
        // Capped below 1: only a finished asset counts as complete, so a
        // compressed response that outgrows its Content-Length cannot claim it.
        const part = tally.expected > 0 ? Math.min(tally.loaded / tally.expected, 0.99) : 0
        weighted += tally.weight * part
      }
    }
    return {
      fraction: weightSum > 0 ? weighted / weightSum : 1,
      loadedBytes: loaded,
      expectedBytes: expected,
      done,
      requested: tallies.size,
      active,
    }
  }

  let progress = snapshot()
  const publish = () => {
    progress = snapshot()
    for (const listener of listeners) {
      listener(progress)
    }
  }

  const specOf = (key: string) => {
    const spec = manifest[key]
    if (!spec) {
      throw new AssetError(`no asset "${key}" in the manifest`)
    }
    return spec
  }

  /** The file's bytes, or null for one that is not there. */
  async function download(key: string, signal: AbortSignal | undefined): Promise<ArrayBuffer | null> {
    const spec = specOf(key)
    const tally = tallies.get(key)!
    // The index says what is there: no request for what is not.
    if (index && !(spec.url in index)) {
      return null
    }
    const url = new URL(spec.url, baseUrl).href
    const response = await fetchFn(url, signal ? { signal } : {})
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new AssetError(`${spec.url}: the server answered ${response.status} ${response.statusText}`.trim())
    }
    // A dev server answers a missing file with its index page and a 200.
    if ((response.headers.get('content-type') ?? '').includes('text/html')) {
      return null
    }

    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > 0) {
      tally.expected = length
      tally.weight = spec.bytes ?? length
      publish()
    }

    if (!response.body) {
      const bytes = await response.arrayBuffer()
      tally.loaded = bytes.byteLength
      publish()
      return bytes
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      chunks.push(value)
      total += value.byteLength
      tally.loaded = total
      publish()
    }
    const bytes = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
      bytes.set(chunk, at)
      at += chunk.byteLength
    }
    return bytes.buffer
  }

  async function fetchAndParse(key: string, signal: AbortSignal | undefined): Promise<unknown | null> {
    const spec = specOf(key)
    await acquire()
    try {
      signal?.throwIfAborted()
      const bytes = await download(key, signal)
      if (bytes === null) {
        if (!spec.optional) {
          throw new AssetError(`${spec.url} is missing (required asset ${key})`)
        }
        log.info(`[assets] ${key}: ${spec.url} not found, using the built-in`)
        return null
      }
      try {
        return await loaders[spec.kind](bytes, key)
      } catch (cause) {
        throw new AssetError(`${spec.url}: ${cause instanceof Error ? cause.message : String(cause)}`, {
          cause,
        })
      }
    } finally {
      release()
    }
  }

  function start(key: string, signal: AbortSignal | undefined): Promise<unknown> {
    const spec = specOf(key)
    // With an index the size is known now, so the bar has this asset's weight
    // from the moment it is asked for, not once a request slot frees up.
    const listed = index?.[spec.url] ?? 0
    tallies.set(key, {
      loaded: 0,
      expected: listed,
      weight: spec.bytes ?? (listed > 0 ? listed : 1),
      finished: false,
    })
    publish()

    const promise = (async (): Promise<unknown> => {
      try {
        const value = await fetchAndParse(key, signal)
        entries.set(key, value === null ? { status: 'missing' } : { status: 'ready', value })
        tallies.get(key)!.finished = true
        publish()
        return value
      } catch (error) {
        if (isAbort(error)) {
          // Not a verdict on the asset: forget it, so a later load starts over.
          entries.delete(key)
          tallies.delete(key)
          publish()
          throw error
        }
        if (spec.optional) {
          log.warn(
            `[assets] ${key}: ${error instanceof Error ? error.message : String(error)} — using the built-in`,
          )
          entries.set(key, { status: 'failed' })
          tallies.get(key)!.finished = true
          publish()
          return null
        }
        // Required: forget it, so a retry (a reload button) is a clean start.
        entries.delete(key)
        tallies.delete(key)
        publish()
        throw error instanceof AssetError ? error : new AssetError(`${key}: ${String(error)}`, { cause: error })
      }
    })()
    entries.set(key, { status: 'loading', promise })
    return promise
  }

  const load = (key: string, signal?: AbortSignal): Promise<never> => {
    // A promise either way, so a caller's `await` and `.catch` both see it.
    if (!manifest[key]) {
      return Promise.reject(new AssetError(`no asset "${key}" in the manifest`))
    }
    const entry = entries.get(key)
    if (entry?.status === 'ready') {
      return Promise.resolve(entry.value as never)
    }
    if (entry?.status === 'loading') {
      return entry.promise as Promise<never>
    }
    if (entry) {
      return Promise.resolve(null as never)
    }
    return start(key, signal) as Promise<never>
  }

  return {
    load: load as AssetManager<M>['load'],
    async loadGroup(group, signal) {
      const keys = Object.keys(manifest).filter(
        (key) => group === undefined || (manifest[key]!.group ?? 'boot') === group,
      )
      await Promise.all(keys.map((key) => load(key, signal)))
    },
    get(key) {
      const entry = entries.get(key)
      return (entry?.status === 'ready' ? entry.value : null) as never
    },
    status(key) {
      return entries.get(key)?.status ?? 'idle'
    },
    get progress() {
      return progress
    },
    onProgress(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** The game's own assets: the manifest in `manifest.ts`. */
export function createGameAssets(options: AssetManagerOptions = {}) {
  return createAssetManager(MANIFEST, options)
}

export type GameAssets = ReturnType<typeof createGameAssets>
