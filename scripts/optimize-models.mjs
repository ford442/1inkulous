#!/usr/bin/env node
//
// Optimises source models for the game: `npm run assets:optimize`.
//
//   npm run assets:optimize                 assets/models/*.glb -> public/models/
//   npm run assets:optimize -- in/ out/     any other pair of directories
//
// Each .glb goes through glTF Transform's `optimize` — welded and indexed,
// positions and normals quantised (KHR_mesh_quantization), buffers compressed
// with meshopt (EXT_meshopt_compression) — which src/assets/gltf.ts reads. It
// runs @gltf-transform/cli through npx at a pinned version rather than adding
// it, and its native dependencies, to the repo; the first run downloads it.
//
// Two flags are not the defaults, and why:
//   --palette false         palettes merge materials, and the follower's band and
//                           club are told apart from its body by material name.
//   --texture-compress false  textures are not read by the loader yet (see
//                           README, "Assets and audio"), so there is nothing to
//                           compress and no need for its image tooling.
//
// glTF optimisers also merge materials whose settings are identical (`dedup`),
// which cannot be turned off here: give a model's parts different base colours
// (`npm run assets:follower` writes an example that does).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const GLTF_TRANSFORM_VERSION = '4.5.1'

export function optimizeArgs(input, output) {
  return [
    '--yes',
    `@gltf-transform/cli@${GLTF_TRANSFORM_VERSION}`,
    'optimize',
    input,
    output,
    '--compress',
    'meshopt',
    '--texture-compress',
    'false',
    '--palette',
    'false',
  ]
}

function main() {
  const root = resolve(import.meta.dirname, '..')
  const source = resolve(process.argv[2] ?? join(root, 'assets/models'))
  const target = resolve(process.argv[3] ?? join(root, 'public/models'))

  if (!existsSync(source)) {
    console.error(
      `error: ${source} does not exist. Put source models (.glb) there, or name a directory.\n` +
        '       `npm run assets:follower` writes the procedural follower out as a starting point.',
    )
    process.exit(2)
  }
  const files = readdirSync(source).filter((name) => name.toLowerCase().endsWith('.glb'))
  if (files.length === 0) {
    console.error(`error: no .glb files in ${source}`)
    process.exit(2)
  }
  mkdirSync(target, { recursive: true })

  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  let failed = 0
  for (const name of files) {
    const input = join(source, name)
    const output = join(target, name)
    console.log(`\n=== ${name}`)
    const run = spawnSync(npx, optimizeArgs(input, output), {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (run.status === 0) {
      const before = statSync(input).size
      const after = statSync(output).size
      console.log(`${name}: ${before} -> ${after} bytes (${((after / before) * 100).toFixed(0)}%)`)
    } else {
      failed += 1
      console.error(`error: could not optimise ${name}`)
    }
  }
  if (failed > 0) {
    process.exit(1)
  }
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  main()
}
