/**
 * Lets `node --experimental-strip-types` import this repo's extension-less
 * TypeScript specifiers (`from '../engine/math'`).
 */
import { register } from 'node:module'

register('./resolve-ts.mjs', import.meta.url)
