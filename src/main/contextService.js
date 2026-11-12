import fs from 'fs/promises'
import { basename, dirname, extname, resolve } from 'path'

// Relative weight of a file type when ranking: notes explain, code implements, data files rarely answer.
const extensionWeights = {
  '.md': 1.4,
  '.mdx': 1.4,
  '.txt': 1.2,
  '.json': 0.5,
  '.yaml': 0.6,
  '.yml': 0.6,
  '.js': 1,
  '.jsx': 1,
  '.ts': 1,
  '.tsx': 1,
  '.py': 1,
  '.java': 1,
  '.go': 1,
  '.rs': 1,
  '.sql': 1
}
const ignoredDirectories = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'target',
  'tmp',
  'vendor',
  'db_dump',
  '__pycache__'
])
const ignoredFiles =
  /(^package-lock\.json$|^yarn\.lock$|^pnpm-lock\.yaml$|\.min\.(js|css)$|\.map$)/i
const testFile = /\.(spec|test|e2e)\.[a-z]+$/i
// Each configured location has its own budget, so a large code repository cannot crowd out the vault.
const MAX_FILES_PER_LOCATION = 8_000
const MAX_CHUNKS_PER_LOCATION = 40_000
const MAX_FILE_BYTES = 300_000
const MAX_CHUNKS_PER_FILE_IN_RESULTS = 2
const CONTEXT_TERM_WEIGHT = 0.3
const PATH_TERM_BONUS = 3
const BM25_K1 = 1.2
const BM25_B = 0.75
const stopwords = new Set(
  `a o os as um uma uns umas de do da dos das em no na nos nas por para pra pro com sem sob sobre entre ate
  e ou mas que se como qual quais quando quanto quantos quantas onde quem porque pois nao sim ja so tambem
  muito mais menos esse essa esses essas este esta estes estas isso isto aquele aquela aquilo ele ela eles elas
  eu tu voce voces nos me te lhe seu sua seus suas meu minha nosso nossa ser estar ter haver fazer vai vao
  foi era sao esta estao tem tinha pode podem seria gente ai la aqui entao tipo assim bem bom dia tarde noite
  the and for with this that from are was you your not but have has can will what when where which who how`
    .split(/\s+/)
    .filter(Boolean)
)

let indexedChunks = []
let postings = new Map()
let averageLength = 1
let indexStatus = { files: 0, chunks: 0, locations: [], errors: [] }

/** Reduces a word to a comparable form: no accents, no plural, so speech and notes match. */
function normalizeTerm(word) {
  let term = word.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{M}/gu, '')
  if (term.length > 4) {
    if (term.endsWith('coes')) term = `${term.slice(0, -4)}cao`
    else if (term.endsWith('oes')) term = `${term.slice(0, -3)}ao`
    else if (term.endsWith('ais')) term = `${term.slice(0, -3)}al`
    else if (term.endsWith('s') && !term.endsWith('ss')) term = term.slice(0, -1)
  }
  return term
}

/** Splits text into searchable terms; identifiers such as `createAverbacao` also yield their parts. */
function tokenize(value = '') {
  const terms = []
  for (const raw of value.match(/[\p{L}\p{N}_]+/gu) || []) {
    const parts = raw.split(/_|(?<=[\p{Ll}\p{N}])(?=\p{Lu})/u).filter(Boolean)
    for (const word of parts.length > 1 ? [raw.replace(/_/g, ''), ...parts] : parts) {
      const term = normalizeTerm(word)
      if (term.length >= 3 && !stopwords.has(term)) terms.push(term)
    }
  }
  return terms
}

function makeChunks(text, path, source) {
  const weight =
    (extensionWeights[extname(path).toLowerCase()] || 1) * (testFile.test(path) ? 0.5 : 1)
  const pathTerms = new Set(tokenize(`${basename(dirname(path))} ${basename(path, extname(path))}`))
  const chunks = []
  for (let start = 0; start < text.length; start += 1_400) {
    const content = text.slice(start, start + 1_700).trim()
    if (content) chunks.push({ path, source, content, weight, pathTerms })
  }
  return chunks
}

async function indexFile(filePath, output, source) {
  const extension = extname(filePath).toLowerCase()
  if (!(extension in extensionWeights) || ignoredFiles.test(basename(filePath))) return
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_FILE_BYTES) return
    const content = await fs.readFile(filePath, 'utf8')
    output.chunks.push(...makeChunks(content, filePath, source))
    output.files += 1
  } catch (error) {
    output.errors.push(`Não foi possível ler ${filePath}: ${error.message}`)
  }
}

function isBudgetSpent(output) {
  return output.files >= MAX_FILES_PER_LOCATION || output.chunks.length >= MAX_CHUNKS_PER_LOCATION
}

async function indexDirectory(directory, output, source) {
  if (isBudgetSpent(output)) return
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    output.errors.push(`Não foi possível abrir ${directory}: ${error.message}`)
    return
  }

  // Files before sub-folders: the notes at the top of a folder are indexed before deep trees.
  entries.sort((first, second) => Number(first.isDirectory()) - Number(second.isDirectory()))
  for (const entry of entries) {
    if (isBudgetSpent(output)) break
    if (entry.isSymbolicLink()) continue
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      // Hidden folders hold tooling state (.git, .obsidian, .claude worktrees), never knowledge.
      if (!entry.name.startsWith('.') && !ignoredDirectories.has(entry.name)) {
        await indexDirectory(entryPath, output, source)
      }
    } else if (entry.isFile()) {
      await indexFile(entryPath, output, source)
    }
  }
}

function buildSearchIndex(chunks) {
  const nextPostings = new Map()
  let totalLength = 0
  chunks.forEach((chunk, index) => {
    const frequencies = new Map()
    const terms = tokenize(chunk.content)
    for (const term of terms) frequencies.set(term, (frequencies.get(term) || 0) + 1)
    chunk.length = terms.length || 1
    totalLength += chunk.length
    for (const [term, frequency] of frequencies) {
      let list = nextPostings.get(term)
      if (!list) nextPostings.set(term, (list = []))
      list.push(index, frequency)
    }
  })
  postings = nextPostings
  averageLength = chunks.length ? totalLength / chunks.length : 1
}

/**
 * Builds an in-memory index for the Obsidian vault and the local project folders.
 * No file content leaves the process at this stage.
 */
export async function indexKnowledgeSources({ projectPaths = '', obsidianVaultPath = '', harnessPath = '' } = {}) {
  // The vault goes first: it holds the curated answers, the projects hold the details.
  const locations = [
    ...new Set(
      [obsidianVaultPath, harnessPath, ...projectPaths.split(/[\n,]/)].map((path) => path.trim()).filter(Boolean)
    )
  ]
  const chunks = []
  const errors = []
  let files = 0

  for (const location of locations) {
    const output = { files: 0, chunks: [], errors }
    const resolvedLocation = resolve(location)
    try {
      const stat = await fs.lstat(resolvedLocation)
      if (stat.isSymbolicLink()) {
        errors.push(`Link simbólico ignorado: ${resolvedLocation}`)
      } else if (stat.isDirectory()) {
        await indexDirectory(resolvedLocation, output, resolvedLocation)
      } else if (stat.isFile()) {
        await indexFile(resolvedLocation, output, resolvedLocation)
      } else {
        errors.push(`Caminho não suportado: ${resolvedLocation}`)
      }
    } catch {
      errors.push(`Caminho não encontrado: ${resolvedLocation}`)
    }
    if (isBudgetSpent(output)) {
      errors.push(
        `Limite de indexação atingido em ${resolvedLocation}; parte dos arquivos ficou de fora.`
      )
    }
    files += output.files
    chunks.push(...output.chunks.slice(0, MAX_CHUNKS_PER_LOCATION))
  }

  indexedChunks = chunks
  buildSearchIndex(indexedChunks)
  indexStatus = { files, chunks: indexedChunks.length, locations, errors }
  console.log(`[Context] Indexed ${indexStatus.files} files into ${indexStatus.chunks} chunks.`)
  return indexStatus
}

export function getKnowledgeIndexStatus() {
  return indexStatus
}

export function getIndexedChunks() {
  return indexedChunks
}

/**
 * Finds the best excerpts for one spoken question or screen capture.
 * `context` is the preceding conversation: its words count, but far less than the question's own.
 */
export function findRelevantContext(query, { limit = 4, source = 'all', context = '' } = {}) {
  if (!indexedChunks.length) return []
  const queryWeights = new Map()
  for (const term of tokenize(context)) queryWeights.set(term, CONTEXT_TERM_WEIGHT)
  for (const term of tokenize(query)) queryWeights.set(term, 1)
  if (!queryWeights.size) return []

  const scores = new Map()
  for (const [term, queryWeight] of queryWeights) {
    const list = postings.get(term)
    if (!list) continue
    const documentFrequency = list.length / 2
    const idf = Math.log(
      1 + (indexedChunks.length - documentFrequency + 0.5) / (documentFrequency + 0.5)
    )
    for (let position = 0; position < list.length; position += 2) {
      const index = list[position]
      const chunk = indexedChunks[index]
      if (source !== 'all' && chunk.source !== source) continue
      const frequency = list[position + 1] + (chunk.pathTerms.has(term) ? PATH_TERM_BONUS : 0)
      const saturation =
        (frequency * (BM25_K1 + 1)) /
        (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * chunk.length) / averageLength))
      scores.set(index, (scores.get(index) || 0) + queryWeight * idf * saturation)
    }
  }

  const perFile = new Map()
  const results = []
  const ranked = [...scores].map(([index, score]) => [index, score * indexedChunks[index].weight])
  ranked.sort((first, second) => second[1] - first[1])
  for (const [index] of ranked) {
    const { path, content, source: chunkSource } = indexedChunks[index]
    const used = perFile.get(path) || 0
    if (used >= MAX_CHUNKS_PER_FILE_IN_RESULTS) continue
    perFile.set(path, used + 1)
    results.push({ path, content, source: chunkSource })
    if (results.length >= limit) break
  }
  return results
}
