import { parseScenario, type Scenario } from './schema'

/**
 * A scenario's canonical text: what the editor exports and what the shipped
 * worlds are written in.
 *
 * The document is parsed first, which both checks it and puts every object's
 * keys in the schema's order, so two documents that mean the same thing are
 * written the same way whatever order their fields were set in. Then it is
 * laid out for a person to read and a diff to show: anything that fits on a
 * line goes on one — a direction, a tree, a unit — and the rest is indented,
 * two spaces a level. Numbers are JavaScript's shortest exact form, so a value
 * read back is the value written. `readScenario(stringifyScenario(s))` is `s`,
 * and stringifying that again gives the same text: the round trip the editor
 * is held to.
 */

const LINE = 100

export function stringifyScenario(scenario: Scenario): string {
  return `${layout(parseScenario(scenario), '')}\n`
}

function inline(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(inline).join(', ')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    return entries.length === 0
      ? '{}'
      : `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`).join(', ')} }`
  }
  return JSON.stringify(value)
}

function layout(value: unknown, indent: string): string {
  const flat = inline(value)
  if (value === null || typeof value !== 'object' || indent.length + flat.length <= LINE) {
    return flat
  }
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    return `[\n${value.map((item) => inner + layout(item, inner)).join(',\n')}\n${indent}]`
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  const lines = entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${layout(item, inner)}`)
  return `{\n${lines.join(',\n')}\n${indent}}`
}
