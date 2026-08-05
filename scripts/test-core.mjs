#!/usr/bin/env node
//
// Headless checks for the WebAssembly simulation core, run with:
//   npm run test:core            (after npm run build:wasm)
//
// Exercises the module through the same Emscripten glue the browser loads, so a
// regression in the C ABI, the fixed-step clock, or the export list fails here
// rather than in the game loop. Exits non-zero on failure, for CI.

import { existsSync } from 'node:fs'

const GLUE = new URL('../src/wasm/core.js', import.meta.url)
if (!existsSync(GLUE)) {
  console.error('error: src/wasm/core.js is missing. Run `npm run build:wasm` first.')
  process.exit(1)
}

const { default: createCoreModule } = await import(GLUE.href)

const out = []
const ok = (name, pass, detail = '') => out.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)

const m = await createCoreModule()
const version = m.UTF8ToString(m._core_version_text())
ok('version string', version === '0.1.0', version)
ok('encoded version matches', m._core_version() === 100, String(m._core_version()))

// default step
m._core_init(0)
ok('default step is 50ms (20Hz)', m._core_step_ms() === 50, String(m._core_step_ms()))
ok('starts at zero', m._core_step_count() === 0 && m._core_elapsed_ms() === 0)

// a frame shorter than one step runs nothing but accumulates
ok('short frame runs no steps', m._core_tick(16.7) === 0)
ok('short frame accumulates', Math.abs(m._core_pending_ms() - 16.7) < 1e-9, String(m._core_pending_ms()))
// three 16.7ms frames = 50.1ms -> exactly one step
m._core_tick(16.7)
ok('third short frame yields one step', m._core_tick(16.7) === 1)
ok('elapsed is whole steps only', m._core_elapsed_ms() === 50, String(m._core_elapsed_ms()))
ok('remainder carried', Math.abs(m._core_pending_ms() - 0.1) < 1e-9, String(m._core_pending_ms()))

// a long frame runs several steps
m._core_reset()
ok('reset clears', m._core_step_count() === 0 && m._core_pending_ms() === 0)
ok('220ms frame runs 4 steps with 20ms carried', m._core_tick(220) === 4 && Math.abs(m._core_pending_ms() - 20) < 1e-9,
   `${m._core_pending_ms()}ms pending`)

// stall guard
m._core_reset()
const stalled = m._core_tick(60_000)
ok('60s stall is capped, not replayed', stalled === 5, `${stalled} steps (cap 250ms / 50ms)`)

// garbage input is ignored
m._core_reset()
ok('negative delta ignored', m._core_tick(-100) === 0 && m._core_pending_ms() === 0)
ok('NaN delta ignored', m._core_tick(NaN) === 0 && m._core_pending_ms() === 0)
ok('Infinity delta capped', m._core_tick(Infinity) === 5)

// simulated time tracks real time over a long run at a fixed frame rate
m._core_init(50)
let steps = 0
for (let i = 0; i < 600; i += 1) steps += m._core_tick(16.6667) // 10s at 60fps
ok('10s at 60fps yields 200 steps', steps === 200, `${steps} steps, ${m._core_elapsed_ms()}ms simulated`)

// custom step length
m._core_init(10)
ok('custom step honoured', m._core_step_ms() === 10 && m._core_tick(100) === 10)

// re-init resets the clock
m._core_init(0)
ok('re-init resets clock', m._core_step_count() === 0 && m._core_step_ms() === 50)

// linear memory is reachable for future bulk reads
ok('heap views exposed', m.HEAPF32 instanceof Float32Array && m.HEAPU8.byteLength > 0,
   `${(m.HEAPU8.byteLength / 1024 / 1024).toFixed(0)}MB linear memory`)

console.log(out.join('\n'))
const failed = out.filter((r) => r.startsWith('FAIL'))
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${out.length} checks passed`)
process.exit(failed.length ? 1 : 0)
