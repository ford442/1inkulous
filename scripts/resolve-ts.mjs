import { extname } from 'node:path'

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../')
  if (relative && extname(specifier) === '') {
    return nextResolve(`${specifier}.ts`, context)
  }
  return nextResolve(specifier, context)
}
