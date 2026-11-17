import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { coreDir, coreRedirected } from './core-dir.mjs'

/**
 * Lets `node --experimental-strip-types` import this repo's extension-less
 * TypeScript specifiers (`from '../engine/math'`), and honours CORE_WASM_DIR
 * for the one import that reaches the generated core.
 */
export async function resolve(specifier, context, nextResolve) {
  if (coreRedirected() && /(^|\/)wasm\/core\.js$/.test(specifier)) {
    return nextResolve(pathToFileURL(join(coreDir(), 'core.js')).href, context)
  }
  const relative = specifier.startsWith('./') || specifier.startsWith('../')
  if (relative && extname(specifier) === '') {
    return nextResolve(`${specifier}.ts`, context)
  }
  return nextResolve(specifier, context)
}
