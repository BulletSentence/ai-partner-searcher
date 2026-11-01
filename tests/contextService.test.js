import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findRelevantContext, indexKnowledgeSources } from '../src/main/contextService.js'
import { isLikelyQuestion } from '../src/main/questionDetector.js'
import { configureTerminology, correctTerminology } from '../src/main/terminologyService.js'

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'meeting-copilot-context-'))
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await mkdir(join(root, '.obsidian'), { recursive: true })
  await writeFile(
    join(root, 'authentication.md'),
    '# Autenticação\nO sistema usa OAuth 2.0 com PKCE e tokens de curta duração.'
  )
  await writeFile(join(root, 'billing.ts'), 'export const billing = "Stripe subscriptions"')
  await writeFile(join(root, 'node_modules', 'ignored.md'), 'this must not be indexed')
  await writeFile(join(root, '.obsidian', 'ignored.md'), 'this must not be indexed')
  await writeFile(join(root, 'binary.pdf'), 'this extension is unsupported')
  return root
}

test('indexes supported project files and skips ignored directories', async (t) => {
  const root = await makeFixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  const status = await indexKnowledgeSources({ projectPaths: root })

  assert.equal(status.files, 2)
  assert.equal(status.errors.length, 0)
  assert.equal(status.locations[0], root)
})

test('returns the most relevant local excerpt for a client question', async (t) => {
  const root = await makeFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await indexKnowledgeSources({ projectPaths: root })

  const results = findRelevantContext('Como funciona a autenticação OAuth com PKCE?')

  assert.ok(results.length > 0)
  assert.match(results[0].path, /authentication\.md$/)
  assert.match(results[0].content, /tokens de curta duração/)
  assert.equal(results[0].source, root)
})

test('reports a missing configured vault without throwing', async () => {
  const status = await indexKnowledgeSources({ obsidianVaultPath: '/path/that/does/not/exist' })

  assert.equal(status.files, 0)
  assert.equal(status.chunks, 0)
  assert.equal(status.errors.length, 1)
  assert.deepEqual(findRelevantContext('autenticação'), [])
})

test('only flags likely spoken questions for automatic AI responses', () => {
  assert.equal(isLikelyQuestion('Como funciona a autenticação OAuth?'), true)
  assert.equal(isLikelyQuestion('Tenho uma dúvida sobre as permissões'), true)
  assert.equal(isLikelyQuestion('A reunião começa às nove horas'), false)
  assert.equal(isLikelyQuestion('ok'), false)
})

test('corrects configured meeting terminology before search and generation', () => {
  configureTerminology([
    { canonical: 'FIDC HAM', aliases: ['fidici ram', 'fidc ram'] },
    { canonical: 'Paketa', aliases: ['paqueta'] }
  ])

  assert.equal(correctTerminology('quem é o fidici ram da paqueta?'), 'quem é o FIDC HAM da Paketa?')
  assert.equal(correctTerminology('a reunião começa às nove'), 'a reunião começa às nove')
})
