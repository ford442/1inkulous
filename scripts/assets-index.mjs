/**
 * The asset index: a small JSON file listing what is actually in `public/models`
 * and `public/audio`, with sizes — `assets-index.json`, emitted by the build and
 * served by the dev server.
 *
 * Why it exists: every asset in the manifest (src/assets/manifest.ts) is
 * optional, and most are absent until art and sound are dropped in. Asking a
 * static host for each file would be a 404 apiece, in red in the console, on
 * every start. The manager reads this one file first, skips the requests for
 * what is not listed, and has each listed file's size before it asks — so the
 * loading bar is honest from the first byte.
 *
 * Shared by the Vite plugin and by the Node tests, like scripts/wgsl.mjs.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Folders under `public/` whose files the game may load. */
export const INDEXED_FOLDERS = ['models', 'audio']

export const INDEX_FILE = 'assets-index.json'

/**
 * `{ 'models/follower.glb': 5940, … }` for `publicDir`, sorted by name so the
 * file does not change between builds that changed nothing. Dot-files
 * (`.gitkeep`) are not assets.
 */
export function scanAssets(publicDir) {
  const found = []
  for (const folder of INDEXED_FOLDERS) {
    const dir = join(publicDir, folder)
    if (!existsSync(dir)) {
      continue
    }
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (!name.startsWith('.') && statSync(path).isFile()) {
        found.push([`${folder}/${name}`, statSync(path).size])
      }
    }
  }
  return Object.fromEntries(found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function assetsIndexPlugin() {
  let publicDir = ''
  return {
    name: '1inkulous-assets-index',
    configResolved(config) {
      publicDir = config.publicDir
    },
    // Read afresh on each request, so a file dropped in is there on reload.
    configureServer(server) {
      server.middlewares.use(`/${INDEX_FILE}`, (_request, response) => {
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-cache')
        response.end(JSON.stringify(scanAssets(publicDir)))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: INDEX_FILE, source: JSON.stringify(scanAssets(publicDir)) })
    },
  }
}
