import { correctWithVocabulary, setPriorityTerms } from './vocabularyService.js'

let replacements = []
let canonicalTerms = []

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Accepts the glossary as `{ canonical, aliases }` entries. */
export function configureTerminology(entries = []) {
  const validEntries = entries
    .filter((entry) => typeof entry?.canonical === 'string')
    .map(({ canonical, aliases = [] }) => ({
      canonical: canonical.trim(),
      aliases: [
        ...new Set(
          [canonical, ...aliases].filter((alias) => typeof alias === 'string' && alias.trim())
        )
      ].map((alias) => alias.trim())
    }))
    .filter((entry) => entry.canonical)

  canonicalTerms = validEntries.map((entry) => entry.canonical)
  replacements = validEntries
    .flatMap(({ canonical, aliases }) => aliases.map((alias) => ({ canonical, alias })))
    .sort((first, second) => second.alias.length - first.alias.length)
  setPriorityTerms(canonicalTerms)
}

/**
 * Reads the glossary typed in the setup screen: one term per line, written as
 * `Canônico: variação 1, variação 2`. Lines starting with `#` are comments.
 */
export function parseTerminologyText(text = '') {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf(':')
      if (separator < 0) return { canonical: line, aliases: [] }
      return {
        canonical: line.slice(0, separator).trim(),
        aliases: line
          .slice(separator + 1)
          .split(',')
          .map((alias) => alias.trim())
          .filter(Boolean)
      }
    })
    .filter((entry) => entry.canonical)
}

/** Writes entries back in the format `parseTerminologyText` reads. */
export function formatTerminology(entries = []) {
  return entries
    .map(({ canonical, aliases = [] }) => {
      const variations = aliases.filter(
        (alias) => alias.toLocaleLowerCase('pt-BR') !== canonical.toLocaleLowerCase('pt-BR')
      )
      return variations.length ? `${canonical}: ${variations.join(', ')}` : canonical
    })
    .join('\n')
}

/**
 * Corrects known meeting terminology without modifying unrelated text: first the typed variations,
 * then names from the knowledge base that Whisper wrote the way they sound.
 */
export function correctTerminology(text = '') {
  let corrected = text
  for (const { canonical, alias } of replacements) {
    const expression = new RegExp(
      `(^|[^\\p{L}\\p{N}])(${escapeRegex(alias)})(?=$|[^\\p{L}\\p{N}])`,
      'giu'
    )
    corrected = corrected.replace(expression, (_match, prefix) => `${prefix}${canonical}`)
  }
  return correctWithVocabulary(corrected)
}

export function getCanonicalTerminology() {
  return canonicalTerms
}
