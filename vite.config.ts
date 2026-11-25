import { join } from 'node:path'
import { defineConfig } from 'vite'
import { assetsIndexPlugin } from './scripts/assets-index.mjs'
import { coreDir, coreRedirected } from './scripts/core-dir.mjs'
import { wgslPlugin } from './scripts/wgsl.mjs'

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  // Relative asset URLs so the build works under test.1ink.us/1inkulous/
  base: './',
  // `import shader from './x.wgsl'` is the shader with its #includes resolved;
  // assets-index.json lists what public/models and public/audio hold.
  plugins: [wgslPlugin(), assetsIndexPlugin()],
  resolve: {
    // `npm run dev:debug` loads the opt-in debug core from its own directory
    // (CORE_WASM_DIR); the source imports stay pointed at src/wasm/ throughout.
    alias: coreRedirected()
      ? [{ find: /^\.\.\/wasm\/core\.js$/, replacement: join(coreDir(), 'core.js') }]
      : [],
  },
  // Cross-origin isolation, so the core's worker can publish its steps into a
  // SharedArrayBuffer. Without these the game still runs, on posted copies.
  // The same two headers belong on the deploy: see deploy.py.
  server: {
    port: 5173,
    open: false,
    headers: ISOLATION_HEADERS,
  },
  preview: {
    headers: ISOLATION_HEADERS,
  },
  worker: {
    // The core's worker imports the Emscripten glue as a module.
    format: 'es',
  },
  build: {
    target: 'esnext',
    // The simulation core is small today, so Vite would inline the .wasm as a
    // base64 data URL — and then quietly switch to emitting a file once it grew
    // past the inline limit. Always emit it: streaming compilation works, and
    // the binary is cached separately from the JS bundle.
    assetsInlineLimit: (filePath) => (filePath.endsWith('.wasm') ? false : undefined),
  },
})
