#!/usr/bin/env node
//
// The C ABI has two hand-kept copies on the TypeScript side of the boundary:
// the declarations in core_abi.h and the `_core_*` members of CoreModule in
// src/wasm/core.d.ts. Nothing generates one from the other, so this is the
// drift guard — it needs no Emscripten and no built core:
//
//   - every `core_*` function the header declares has a `_core_*` member, and
//     the other way round;
//   - they agree on how many arguments it takes and whether it returns a value;
//   - every declared function is defined and exported in core_abi.cpp, so the
//     typed member is not a promise the built module cannot keep.
//
// Run: npm run test:abi

import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const HEADER = 'cpp/include/1inkulous/core_abi.h'
const SHIMS = 'cpp/src/core_abi.cpp'
const TYPES = 'src/wasm/core.d.ts'

/** Source with comments removed, so a function named in prose is not a declaration. */
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** Splits an argument list on top-level commas; `(void)` and `()` have none. */
function argumentCount(list) {
  const trimmed = list.trim()
  if (trimmed === '' || trimmed === 'void') return 0
  let depth = 0
  let count = 1
  for (const char of trimmed) {
    if (char === '<' || char === '(' || char === '[' || char === '{') depth += 1
    else if (char === '>' || char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) count += 1
  }
  // A trailing comma (prettier puts one on a wrapped list) is not an argument.
  return /,\s*$/.test(trimmed) ? count - 1 : count
}

/** `core_name` -> { args, returns } for every function the header declares. */
function headerFunctions() {
  const source = withoutComments(read(HEADER))
  const found = new Map()
  const declaration = /([A-Za-z_][\w\s*]*?)\b(core_\w+)\s*\(([^)]*)\)\s*;/g
  for (const [, type, name, list] of source.matchAll(declaration)) {
    found.set(name, { args: argumentCount(list), returns: type.trim() !== 'void' })
  }
  return found
}

/** `core_name` -> { args, returns } for every `_core_*` member of CoreModule. */
function typedFunctions() {
  const source = withoutComments(read(TYPES))
  const found = new Map()
  const member = /\b_(core_\w+)\s*:\s*\(([^)]*)\)\s*=>\s*([\w[\]|<> ]+)/g
  for (const [, name, list, returns] of source.matchAll(member)) {
    found.set(name, { args: argumentCount(list), returns: returns.trim() !== 'void' })
  }
  return found
}

/** Names defined with INKULOUS_EXPORT in the shims — what the module really exports. */
function exportedNames() {
  const source = withoutComments(read(SHIMS))
  const names = new Set()
  for (const [, name] of source.matchAll(/INKULOUS_EXPORT\b[^;{(]*?\b(core_\w+)\s*\(/g)) {
    names.add(name)
  }
  return names
}

const declared = headerFunctions()
const typed = typedFunctions()
const exported = exportedNames()

const problems = []
const shape = ({ args, returns }) => `${args} argument${args === 1 ? '' : 's'}, ${returns ? 'returns a value' : 'void'}`

for (const [name, header] of declared) {
  const member = typed.get(name)
  if (!member) {
    problems.push(`${name} is declared in ${HEADER} but has no _${name} in ${TYPES}`)
  } else if (member.args !== header.args || member.returns !== header.returns) {
    problems.push(
      `${name} differs: ${HEADER} says ${shape(header)}; _${name} in ${TYPES} says ${shape(member)}`,
    )
  }
  if (!exported.has(name)) {
    problems.push(`${name} is declared in ${HEADER} but ${SHIMS} does not define it with INKULOUS_EXPORT`)
  }
}
for (const name of typed.keys()) {
  if (!declared.has(name)) {
    problems.push(`_${name} is in ${TYPES} but ${name} is not declared in ${HEADER}`)
  }
}
for (const name of exported) {
  if (!declared.has(name)) {
    problems.push(`${name} is exported by ${SHIMS} but not declared in ${HEADER}`)
  }
}

// A parser that quietly finds nothing would pass everything above.
if (declared.size < 10) {
  problems.push(`only ${declared.size} declarations parsed out of ${HEADER}; the check itself is broken`)
}

if (problems.length > 0) {
  console.error(`ABI drift between ${HEADER} and ${TYPES}:\n`)
  for (const problem of problems) console.error(`  FAIL ${problem}`)
  console.error(`\n${problems.length} problem(s). Mirror the change in ${TYPES} (and export it in ${SHIMS}).`)
  process.exit(1)
}

console.log(`ok  ${declared.size} core_* functions: header, ${TYPES} and ${SHIMS} agree`)
