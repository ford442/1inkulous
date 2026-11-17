/**
 * Where the Emscripten glue (core.js + core.wasm) is loaded from.
 *
 * `src/wasm/` normally — the release build `npm run build:wasm` writes there.
 * Set CORE_WASM_DIR to point the tests and the Vite dev server at another
 * build instead, e.g. the opt-in debug one:
 *
 *   CORE_WASM_DIR=cpp/build-wasm-debug/out npm run test:core
 *
 * Relative paths resolve from the repository root.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export const coreDir = () => resolve(ROOT, process.env.CORE_WASM_DIR || 'src/wasm')

/** True when CORE_WASM_DIR redirects the core away from src/wasm/. */
export const coreRedirected = () => Boolean(process.env.CORE_WASM_DIR)
