import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

/**
 * `.wgsl` imports, the way the Vite plugin gives them: the shader's composed
 * source as the default export (scripts/wgsl.mjs). So a test can import a
 * module that imports a shader, and sees the same code the GPU is given.
 */
export async function load(url, context, nextLoad) {
  if (url.endsWith('.wgsl')) {
    const { composeWgsl } = await import('./wgsl.mjs')
    const { code } = composeWgsl(fileURLToPath(url))
    return { format: 'module', source: `export default ${JSON.stringify(code)};`, shortCircuit: true }
  }
  return nextLoad(url, context)
}
