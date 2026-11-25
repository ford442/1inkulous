#!/usr/bin/env node
//
// Runs every `test:*` script in package.json, in the order they are listed, and
// reports them together. CI calls this instead of naming each script, so a test
// added to package.json is run without anyone remembering to add it to the
// workflow as well.
//
//   npm test                # all of them; needs `npm run build:wasm` first
//   npm test -- core huts   # just those (`test:core`, `test:huts`)

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const all = Object.keys(scripts).filter((name) => name.startsWith('test:'))
const wanted = process.argv.slice(2).map((name) => (name.startsWith('test:') ? name : `test:${name}`))
const unknown = wanted.filter((name) => !all.includes(name))
if (unknown.length > 0) {
  console.error(`error: no such script: ${unknown.join(', ')} (have ${all.join(', ')})`)
  process.exit(2)
}
const names = wanted.length > 0 ? wanted : all
if (names.length === 0) {
  console.error('error: package.json has no test:* scripts to run')
  process.exit(2)
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const results = []
for (const name of names) {
  console.log(`\n=== npm run ${name}`)
  const started = performance.now()
  const run = spawnSync(npm, ['run', '--silent', name], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  results.push({ name, passed: run.status === 0, seconds: (performance.now() - started) / 1000 })
}

console.log('\n=== summary')
const width = Math.max(...results.map(({ name }) => name.length))
for (const { name, passed, seconds } of results) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name.padEnd(width)} ${seconds.toFixed(1)}s`)
}
const failed = results.filter((result) => !result.passed)
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} test scripts failed: ${failed.map((r) => r.name).join(', ')}`)
  process.exit(1)
}
console.log(`\nall ${results.length} test scripts passed`)
