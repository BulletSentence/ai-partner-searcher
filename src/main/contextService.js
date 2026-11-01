import fs from 'fs/promises'
import { basename, extname, resolve } from 'path'

const supportedExtensions = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.sql'
])
const ignoredDirectories = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.obsidian',
  '.trash'
])
const MAX_FILES = 500
const MAX_FILE_BYTES = 300_000
const MAX_CHUNKS = 3_000

let indexedChunks = []
let indexStatus = { files: 0, chunks: 0, locations: [], errors: [] }

function tokenize(value = '') {
  return [...new Set(value.toLocaleLowerCase('pt-BR').match(/[\p{L}\p{N}_-]{3,}/gu) || [])]
}

function makeChunks(text, path, source) {
  const chunks = []
  for (let start = 0; start < text.length; start += 1_400) {
    const content = text.slice(start, start + 1_700).trim()
    if (content) {
      chunks.push({
        path,
        source,
        content,
        terms: new Set(tokenize(content)),
        pathTerms: new Set(tokenize(basename(path)))
      })
    }
  }
  return chunks
}

async function indexFile(filePath, output, source) {
  if (!supportedExtensions.has(extname(filePath).toLowerCase())) return
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

async function indexDirectory(directory, output, source) {
  if (output.files >= MAX_FILES || output.chunks.length >= MAX_CHUNKS) return
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    output.errors.push(`Não foi possível abrir ${directory}: ${error.message}`)
    return
  }

  for (const entry of entries) {
    if (output.files >= MAX_FILES || output.chunks.length >= MAX_CHUNKS) break
    if (entry.isSymbolicLink()) continue
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await indexDirectory(entryPath, output, source)
    } else if (entry.isFile()) {
      await indexFile(entryPath, output, source)
    }
  }
}

/**
 * Builds a bounded in-memory index for local project folders and an Obsidian vault.
 * No file content leaves the process at this stage.
 */
export async function indexKnowledgeSources({ projectPaths = '', obsidianVaultPath = '' } = {}) {
  const locations = [...new Set([...projectPaths.split(/[\n,]/), obsidianVaultPath].map((path) => path.trim()).filter(Boolean))]
  const output = { files: 0, chunks: [], errors: [] }

  for (const location of locations) {
    if (output.files >= MAX_FILES || output.chunks.length >= MAX_CHUNKS) break
    const resolvedLocation = resolve(location)
    try {
      const stat = await fs.lstat(resolvedLocation)
      if (stat.isSymbolicLink()) {
        output.errors.push(`Link simbólico ignorado: ${resolvedLocation}`)
      } else if (stat.isDirectory()) {
        await indexDirectory(resolvedLocation, output, resolvedLocation)
      } else if (stat.isFile()) {
        await indexFile(resolvedLocation, output, resolvedLocation)
      } else {
        output.errors.push(`Caminho não suportado: ${resolvedLocation}`)
      }
    } catch {
      output.errors.push(`Caminho não encontrado: ${resolvedLocation}`)
    }
  }

  indexedChunks = output.chunks.slice(0, MAX_CHUNKS)
  indexStatus = {
    files: output.files,
    chunks: indexedChunks.length,
    locations,
    errors: output.errors
  }
  console.log(`[Context] Indexed ${indexStatus.files} files into ${indexStatus.chunks} chunks.`)
  return indexStatus
}

export function getKnowledgeIndexStatus() {
  return indexStatus
}

export function getIndexedChunks() {
  return indexedChunks
}

/** Finds the highest-overlap excerpts for one spoken question or screen capture. */
export function findRelevantContext(query, { limit = 4, source = 'all' } = {}) {
  const queryTerms = tokenize(query)
  if (!queryTerms.length || !indexedChunks.length) return []

  return indexedChunks
    .filter((chunk) => source === 'all' || chunk.source === source)
    .map((chunk) => ({
      ...chunk,
      score: queryTerms.reduce(
        (total, term) => total + (chunk.terms.has(term) ? 1 : 0) + (chunk.pathTerms.has(term) ? 3 : 0),
        0
      )
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((first, second) => second.score - first.score)
    .slice(0, limit)
    .map(({ path, content, source: chunkSource }) => ({ path, content, source: chunkSource }))
}
