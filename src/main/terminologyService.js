import fs from 'fs/promises'
import { join } from 'path'

let replacements = []
let canonicalTerms = []

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Parses `Canonical: alias 1, alias 2` lines supplied by the meeting owner. */
export function configureTerminology(entries = []) {
  const validEntries = entries
    .filter((entry) => typeof entry?.canonical === 'string')
    .map(({ canonical, aliases = [] }) => ({
      canonical: canonical.trim(),
      aliases: [...new Set([canonical, ...aliases].filter((alias) => typeof alias === 'string' && alias.trim()))]
    }))
    .filter((entry) => entry.canonical)

  canonicalTerms = validEntries.map((entry) => entry.canonical)
  replacements = validEntries
    .flatMap(({ canonical, aliases }) => aliases.map((alias) => ({ canonical, alias })))
    .sort((first, second) => second.alias.length - first.alias.length)
}

/** Loads the editable terminology grammar stored beside the project. */
export async function loadTerminologyFile() {
  const path = join(process.cwd(), 'meeting-grammar.json')
  try {
    const grammar = JSON.parse(await fs.readFile(path, 'utf8'))
    configureTerminology(Array.isArray(grammar.terms) ? grammar.terms : [])
    return { path, count: canonicalTerms.length, error: null }
  } catch (error) {
    configureTerminology([])
    return { path, count: 0, error: error.message }
  }
}

/** Corrects known meeting terminology without modifying unrelated text. */
export function correctTerminology(text = '') {
  let corrected = text
  for (const { canonical, alias } of replacements) {
    const expression = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegex(alias)})(?=$|[^\\p{L}\\p{N}])`, 'giu')
    corrected = corrected.replace(expression, (_match, prefix) => `${prefix}${canonical}`)
  }
  return corrected
}

export function getCanonicalTerminology() {
  return canonicalTerms
}
