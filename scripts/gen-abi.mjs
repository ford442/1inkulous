#!/usr/bin/env node
//
// Regenerates src/wasm/core-abi.d.ts from cpp/include/1inkulous/core_abi.h.
//
//   npm run gen:abi            write it
//   node scripts/gen-abi.mjs --check
//                              exit 1 if the file on disk is not what the header
//                              produces (what `npm run test:abi` does)

import { readFileSync, writeFileSync } from 'node:fs'
import { GENERATED, HEADER, render } from './abi-header.mjs'

const target = new URL(`../${GENERATED}`, import.meta.url)
const wanted = render()

if (process.argv.includes('--check')) {
  const have = (() => {
    try {
      return readFileSync(target, 'utf8')
    } catch {
      return null
    }
  })()
  if (have !== wanted) {
    console.error(`${GENERATED} is out of date with ${HEADER}. Run \`npm run gen:abi\`.`)
    process.exit(1)
  }
  console.log(`ok  ${GENERATED} matches ${HEADER}`)
} else {
  writeFileSync(target, wanted)
  console.log(`wrote ${GENERATED} from ${HEADER}`)
}
