/**
 * WGSL module composition: `#include "lib/frame.wgsl"` pulls one shader file
 * into another, so the frame's uniforms, the lighting and the exposure curve
 * are written once instead of once per shader.
 *
 * Shared by the Vite plugin (which composes every `.wgsl` import at build
 * time) and by the Node checks (which compose the same files to inspect
 * them), so what the tests read is what the GPU is given.
 *
 * - Paths are relative to the including file.
 * - Each file is included at most once per composed shader, however many
 *   files ask for it: `lib/lighting.wgsl` and `planet.wgsl` can both include
 *   `lib/frame.wgsl` and the struct is declared once.
 * - A cycle is an error naming the chain, not a stack overflow.
 * - `#ifdef` / `#else` / `#endif` lines pass through untouched: which branch
 *   is kept depends on the device's features, so it is decided at runtime by
 *   specializeWgsl in src/engine/wgsl.ts.
 */
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const INCLUDE = /^[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/gm

/**
 * Composes the shader at `path`. `read` is injectable for tests; it is given
 * an absolute path and returns the file's text.
 *
 * Returns the code and every file that went into it (the root first), which
 * the plugin hands to Vite so editing an included file reloads its users.
 */
export function composeWgsl(path, read = (file) => readFileSync(file, 'utf8')) {
  const included = new Set()
  const files = []

  const visit = (file, chain) => {
    if (chain.includes(file)) {
      const loop = [...chain.slice(chain.indexOf(file)), file].map((f) => relative(dirname(path), f))
      throw new Error(`WGSL include cycle: ${loop.join(' -> ')}`)
    }
    if (included.has(file)) {
      return ''
    }
    included.add(file)
    files.push(file)
    let source
    try {
      source = read(file)
    } catch (cause) {
      const from = chain.length > 0 ? ` (included from ${chain[chain.length - 1]})` : ''
      throw new Error(`WGSL include not found: ${file}${from}`, { cause })
    }
    return source.replace(INCLUDE, (_line, target) =>
      visit(resolve(dirname(file), target), [...chain, file]).replace(/\n+$/, ''),
    )
  }

  const code = visit(resolve(path), [])
  return { code, files }
}

/**
 * The Vite side: `import shader from './x.wgsl'` gives the composed source as
 * a string. Imports with a query (`?raw`, `?url`) are left to Vite.
 */
export function wgslPlugin() {
  return {
    name: '1inkulous:wgsl',
    enforce: 'pre',
    load(id) {
      if (!id.endsWith('.wgsl')) {
        return null
      }
      const { code, files } = composeWgsl(id)
      for (const file of files.slice(1)) {
        this.addWatchFile(file)
      }
      return { code: `export default ${JSON.stringify(code)};`, map: null }
    },
  }
}
