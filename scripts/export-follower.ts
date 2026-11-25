/**
 * Writes the procedural follower out as a .glb: `npm run assets:follower`.
 *
 * The file follows the conventions a replacement model has to (+Y up, facing +Z,
 * the headband and club as materials named `band` and `club`, everything else
 * the body), so an artist can open it, see them, and model over it. Put the
 * result in `assets/models/` and run `npm run assets:optimize`.
 *
 *   npm run assets:follower [-- path/to/out.glb]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createFollowerMesh } from '../src/engine/mesh/followerMesh.ts'
import { followerGlb } from './follower-glb.ts'

const out = resolve(process.argv[2] ?? 'assets/models/follower.glb')
// World scale does not matter: the loader scales the body to the follower's height.
const glb = followerGlb(createFollowerMesh({ height: 1.8, radius: 0.72 }))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, glb)
console.log(`wrote ${out} (${glb.length} bytes)`)
