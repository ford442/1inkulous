import { join } from 'node:path'
import { defineConfig } from 'vite'
import { coreDir, coreRedirected } from './scripts/core-dir.mjs'

export default defineConfig({
  // Relative asset URLs so the build works under test.1ink.us/1inkulous/
  base: './',
  resolve: {
    // `npm run dev:debug` loads the opt-in debug core from its own directory
    // (CORE_WASM_DIR); the source imports stay pointed at src/wasm/ throughout.
    alias: coreRedirected()
      ? [{ find: /^\.\.\/wasm\/core\.js$/, replacement: join(coreDir(), 'core.js') }]
      : [],
  },
  server: {
    port: 5173,
    open: false,
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
