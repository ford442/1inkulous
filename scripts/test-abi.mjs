#!/usr/bin/env node
//
// The C ABI is declared once, in core_abi.h. The TypeScript side of it,
// src/wasm/core-abi.d.ts, is generated from that header (`npm run gen:abi`), so
// this is the drift guard for the two places the header is still mirrored by
// hand — it needs no Emscripten and no built core:
//
//   - the generated typings are exactly what the header produces now, so a
//     header edit that nobody regenerated fails here;
//   - every `core_*` function the header declares is defined and exported in
//     core_abi.cpp, and every export is declared, so a typed member is not a
//     promise the built module cannot keep.
//
// Run: npm run test:abi

import { readFileSync } from 'node:fs'
import { GENERATED, HEADER, parseHeader, read, render } from './abi-header.mjs'

const SHIMS = 'cpp/src/core_abi.cpp'

/** Source with comments removed, so a function named in prose is not a definition. */
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** Names defined with INKULOUS_EXPORT in the shims — what the module really exports. */
function exportedNames() {
  const names = new Set()
  for (const [, name] of withoutComments(read(SHIMS)).matchAll(/INKULOUS_EXPORT\b[^;{(]*?\b(core_\w+)\s*\(/g)) {
    names.add(name)
  }
  return names
}

const functions = parseHeader()
const declared = new Set(functions.map((fn) => fn.name))
const exported = exportedNames()

const problems = []

const onDisk = readFileSync(new URL(`../${GENERATED}`, import.meta.url), 'utf8')
if (onDisk !== render(functions)) {
  problems.push(`${GENERATED} is not what ${HEADER} produces: run \`npm run gen:abi\``)
}

for (const name of declared) {
  if (!exported.has(name)) {
    problems.push(`${name} is declared in ${HEADER} but ${SHIMS} does not define it with INKULOUS_EXPORT`)
  }
}
for (const name of exported) {
  if (!declared.has(name)) {
    problems.push(`${name} is exported by ${SHIMS} but not declared in ${HEADER}`)
  }
}
if (declared.size !== functions.length) {
  const seen = new Set()
  for (const { name } of functions) {
    if (seen.has(name)) problems.push(`${name} is declared twice in ${HEADER}`)
    seen.add(name)
  }
}

// A parser that quietly finds nothing would pass everything above.
if (declared.size < 10) {
  problems.push(`only ${declared.size} declarations parsed out of ${HEADER}; the check itself is broken`)
}

if (problems.length > 0) {
  console.error('C ABI drift:\n')
  for (const problem of problems) console.error(`  FAIL ${problem}`)
  console.error(`\n${problems.length} problem(s).`)
  process.exit(1)
}

console.log(`ok  ${declared.size} core_* functions: ${HEADER}, ${GENERATED} and ${SHIMS} agree`)
