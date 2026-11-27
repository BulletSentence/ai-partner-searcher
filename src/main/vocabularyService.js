import { createYielder } from './cooperative.js'

// Proper names learned from the indexed notes, used to steer Whisper and to repair names it mishears.
// Everything here runs once per indexing or in microseconds per utterance: lookups are by key, and the
// fuzzy comparison only visits terms that share the first sound of the heard word.

const PROSE_FILE = /\.(md|mdx|txt)$/i
const MIN_WORD_LENGTH = 4
// A name must be seen capitalized in the middle of a sentence at least this often.
const MIN_PROPER_COUNT = 3
// ...and capitalized at least this many times for every lowercase use, so ordinary words stay out.
const PROPER_TO_LOWER_RATIO = 2
// Below this phonetic length only an exact sound match corrects; one-letter slips need longer words.
const MIN_FUZZY_KEY_LENGTH = 6
const MAX_LEARNED_TERMS = 5_000

let learnedTerms = [] // [{ term, key, sound, count }] most frequent first
let priorityTerms = [] // single-word names typed by the meeting owner
let wordStats = new Map() // folded word -> { lower, proper }
let byKey = new Map() // folded word -> term
let bySound = new Map() // phonetic key -> term, or null when two names sound alike
let bySoundStart = new Map() // first phonetic letter -> [{ sound, term }]

/** Lowercase without accents: "Paketá", "PAKETA" and "paketa" are the same word. */
export function foldWord(word = '') {
  return word.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{M}/gu, '')
}

/**
 * Reduces a word to how it sounds in Brazilian Portuguese, so that spellings Whisper produces for the
 * same sound meet: "Paketá", "Paquetá" and "Pakéta" all become "paketa".
 */
export function phoneticKey(word = '') {
  return foldWord(word.replace(/[çÇ]/g, 's'))
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/sch|ch|sh/g, 'x')
    .replace(/lh/g, 'li')
    .replace(/nh/g, 'ni')
    .replace(/qu(?=[ei])/g, 'k')
    .replace(/gu(?=[ei])/g, 'g')
    .replace(/q/g, 'k')
    .replace(/[sx]c(?=[ei])/g, 's')
    .replace(/c(?=[ei])/g, 's')
    .replace(/c/g, 'k')
    .replace(/g(?=[ei])/g, 'j')
    .replace(/(?<=[aeiou])s(?=[aeiou])/g, 'z')
    .replace(/h/g, '')
    .replace(/w/g, 'v')
    .replace(/y/g, 'i')
    .replace(/z$/, 's')
    .replace(/l(?=[^aeiou]|$)/g, 'u')
    .replace(/m(?=[^aeiou]|$)/g, 'n')
    .replace(/e$/, 'i')
    .replace(/o$/, 'u')
    .replace(/(.)\1+/g, '$1')
}

/** True when an edit distance of at most one (insertion, deletion, substitution or swap) separates them. */
function withinOneEdit(first, second) {
  if (first === second) return true
  const lengthDifference = first.length - second.length
  if (Math.abs(lengthDifference) > 1) return false
  let index = 0
  while (index < first.length && index < second.length && first[index] === second[index]) index += 1
  if (lengthDifference === 0) {
    if (first.slice(index + 1) === second.slice(index + 1)) return true
    return (
      first[index] === second[index + 1] &&
      first[index + 1] === second[index] &&
      first.slice(index + 2) === second.slice(index + 2)
    )
  }
  return lengthDifference > 0
    ? first.slice(index + 1) === second.slice(index)
    : first.slice(index) === second.slice(index + 1)
}

// A capitalized word right after a lowercase word or a comma is a name, not a sentence start or a
// Title Case heading ("Manual de Definições Gerais" teaches nothing; "falar com a Paketá" does).
function isMidSentence(content, index) {
  let position = index - 1
  while (position >= 0 && (content[position] === ' ' || content[position] === '\t')) position -= 1
  if (position < 0 || position === index - 1) return false
  if (content[position] === ',') return true
  if (!/\p{Ll}/u.test(content[position])) return false
  let start = position
  while (start > 0 && /\p{L}/u.test(content[start - 1])) start -= 1
  return /\p{Ll}/u.test(content[start])
}

// Code samples inside notes (SQL, JSON, shell) are full of capitalized keywords nobody says aloud.
function stripCode(content) {
  return content.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

function rebuildLookup() {
  byKey = new Map()
  bySound = new Map()
  bySoundStart = new Map()
  const seen = new Set()
  // Typed names come first, so they win when a learned name sounds the same.
  for (const entry of [...priorityTerms, ...learnedTerms]) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    byKey.set(entry.key, entry.term)
    if (!bySound.has(entry.sound)) bySound.set(entry.sound, entry.term)
    const bucket = bySoundStart.get(entry.sound[0]) || []
    bucket.push({ sound: entry.sound, term: entry.term })
    bySoundStart.set(entry.sound[0], bucket)
  }
}

/**
 * Learns the proper names of the knowledge base from the indexed chunks. Only notes count:
 * code is full of identifiers that are not spoken the way they are written.
 */
export async function buildVocabulary(chunks = [], { onProgress, signal } = {}) {
  const started = Date.now()
  const maybeYield = createYielder(signal)
  const stats = new Map()
  const forms = new Map() // folded word -> Map(surface form -> count)
  for (const [index, chunk] of chunks.entries()) {
    if (index % 200 === 0) {
      onProgress?.(index, chunks.length)
      await maybeYield()
    }
    if (!PROSE_FILE.test(chunk.path || '')) continue
    const content = stripCode(chunk.content)
    for (const match of content.matchAll(/\p{L}+/gu)) {
      const word = match[0]
      if (word.length < MIN_WORD_LENGTH) continue
      const rest = word.slice(1)
      const isUpperStart = word[0] !== word[0].toLocaleLowerCase('pt-BR')
      const isAllCaps = word === word.toLocaleUpperCase('pt-BR')
      // camelCase and PascalCase identifiers inside notes are code, not speech.
      if (!isAllCaps && rest !== rest.toLocaleLowerCase('pt-BR')) continue
      const key = foldWord(word)
      let entry = stats.get(key)
      if (!entry) stats.set(key, (entry = { lower: 0, proper: 0, caps: 0 }))
      if (!isUpperStart) {
        entry.lower += 1
        continue
      }
      // Acronyms (FIDC, FGTS) are spelled out letter by letter: the typed glossary handles those.
      if (isAllCaps) {
        entry.caps += 1
        continue
      }
      if (isMidSentence(content, match.index)) entry.proper += 1
      let wordForms = forms.get(key)
      if (!wordForms) forms.set(key, (wordForms = new Map()))
      wordForms.set(word, (wordForms.get(word) || 0) + 1)
    }
  }

  const terms = []
  for (const [key, { lower, proper, caps }] of stats) {
    const wordForms = forms.get(key)
    if (!wordForms || proper < MIN_PROPER_COUNT || proper < lower * PROPER_TO_LOWER_RATIO) continue
    if (caps > proper) continue
    const term = [...wordForms].sort((first, second) => second[1] - first[1])[0][0]
    terms.push({ term, key, sound: phoneticKey(term), count: proper })
  }
  terms.sort((first, second) => second.count - first.count)
  onProgress?.(chunks.length, chunks.length)
  learnedTerms = terms.slice(0, MAX_LEARNED_TERMS)
  wordStats = stats
  rebuildLookup()
  return { terms: learnedTerms.length, ms: Date.now() - started }
}

/** Names typed by the meeting owner; only single words are matched by sound. */
export function setPriorityTerms(terms = []) {
  priorityTerms = terms
    .map((term) => term.trim())
    .filter((term) => /^\p{L}+$/u.test(term) && term.length >= MIN_WORD_LENGTH)
    .map((term) => ({ term, key: foldWord(term), sound: phoneticKey(term), count: Infinity }))
  rebuildLookup()
}

export function getLearnedTerms() {
  return learnedTerms.map(({ term, count }) => ({ term, count }))
}

// A word the notes use in lowercase is a real word: it is never swapped for a similar-sounding name.
function isCommonWord(key) {
  const entry = wordStats.get(key)
  return Boolean(entry && entry.lower >= 2 && entry.lower * PROPER_TO_LOWER_RATIO > entry.proper)
}

function findTerm(word) {
  if (word.length < MIN_WORD_LENGTH) return null
  const key = foldWord(word)
  if (byKey.has(key)) return byKey.get(key)
  if (isCommonWord(key)) return null
  const sound = phoneticKey(word)
  const exact = bySound.get(sound)
  if (exact) return exact
  if (exact === null || sound.length < MIN_FUZZY_KEY_LENGTH) return null
  let found = null
  for (const candidate of bySoundStart.get(sound[0]) || []) {
    if (candidate.sound.length < MIN_FUZZY_KEY_LENGTH || !withinOneEdit(sound, candidate.sound))
      continue
    // Two names one slip away: guessing would be worse than leaving the word alone.
    if (found && found !== candidate.term) return null
    found = candidate.term
  }
  return found
}

// "Data prev" and "Credi fit": a name Whisper split in two, recognised only by its exact sound.
function findSplitTerm(first, second) {
  const key = foldWord(first + second)
  if (byKey.has(key)) return byKey.get(key)
  const sound = phoneticKey(first + second)
  if (sound.length < MIN_FUZZY_KEY_LENGTH || isCommonWord(key)) return null
  return bySound.get(sound) || null
}

/** Replaces misheard names with the spelling used in the notes; everything else is left untouched. */
export function correctWithVocabulary(text = '') {
  if (!byKey.size || !text) return text
  const words = [...text.matchAll(/\p{L}+/gu)]
  let output = ''
  let cursor = 0
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const next = words[index + 1]
    const end = word.index + word[0].length
    if (next && /^[ -]$/.test(text.slice(end, next.index)) && !byKey.has(foldWord(word[0]))) {
      const joined = findSplitTerm(word[0], next[0])
      if (joined) {
        output += text.slice(cursor, word.index) + joined
        cursor = next.index + next[0].length
        index += 1
        continue
      }
    }
    const term = findTerm(word[0])
    // Only spelling is repaired: "produtos" is not turned into "Produtos" just because a heading says so.
    if (term && term.toLocaleLowerCase('pt-BR') !== word[0].toLocaleLowerCase('pt-BR')) {
      output += text.slice(cursor, word.index) + term
      cursor = end
    }
  }
  return output + text.slice(cursor)
}

/**
 * Picks the learned names worth telling Whisper about: first those in the notes related to the
 * meeting, then the most frequent ones in the whole base.
 */
export function selectPromptTerms({ relatedText = '', exclude = [], limit = 40 } = {}) {
  const excluded = new Set(exclude.map(foldWord))
  const related = new Map()
  for (const [word] of relatedText.matchAll(/\p{L}+/gu)) {
    const key = foldWord(word)
    const term = byKey.get(key)
    if (term && !excluded.has(key)) related.set(term, (related.get(term) || 0) + 1)
  }
  const selected = [...related].sort((first, second) => second[1] - first[1]).map(([term]) => term)
  for (const { term, key } of learnedTerms) {
    if (selected.length >= limit) break
    if (!excluded.has(key) && !related.has(term)) selected.push(term)
  }
  return selected.slice(0, limit)
}

export function resetVocabulary() {
  learnedTerms = []
  priorityTerms = []
  wordStats = new Map()
  rebuildLookup()
}
