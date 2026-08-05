import { defineConfig } from 'vite'

export default defineConfig({
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
