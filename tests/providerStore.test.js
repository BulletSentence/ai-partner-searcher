import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProviderStore } from '../src/main/providerStore.js'

const OPENAI_KEY = 'sk-proj-' + 'a'.repeat(40) + 'ZZ99'
const CLAUDE_KEY = 'sk-ant-api03-' + 'b'.repeat(40) + 'YY88'

// Stands in for safeStorage: reversible, and clearly not plain text.
const encrypt = (text) =>
  Buffer.from(Buffer.from(text).toString('base64').split('').reverse().join(''))
const decrypt = (buffer) =>
  Buffer.from(buffer.toString().split('').reverse().join(''), 'base64').toString()

function fakeFetch(url) {
  const body = url.includes('openai')
    ? {
        data: [
          { id: 'gpt-6-luna', created: 2 },
          { id: 'gpt-4o-mini', created: 1 }
        ]
      }
    : url.includes('anthropic')
      ? { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }] }
      : url.includes('11434')
        ? { models: [{ name: 'gemma2:2b' }] }
        : {}
  return Promise.resolve({ ok: true, status: 200, json: async () => body })
}

async function makeStore(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'provider-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filePath = join(dir, 'ai-providers.bin')
  const create = () =>
    createProviderStore({ filePath, encrypt, decrypt, fetchImpl: fakeFetch, ...options })
  return { filePath, store: create(), reopen: create }
}

test('keys are saved encrypted and never returned to the screen', async (t) => {
  const { filePath, store, reopen } = await makeStore(t)
  assert.deepEqual(await store.addKey(OPENAI_KEY), { provider: 'openai', models: 2 })

  const onDisk = await readFile(filePath, 'utf8')
  assert.ok(
    !onDisk.includes(OPENAI_KEY) && !onDisk.includes('gpt-6-luna'),
    'file must not be plain text'
  )

  const state = await reopen().getPublicState()
  assert.ok(!JSON.stringify(state).includes(OPENAI_KEY))
  const openai = state.providers.find((provider) => provider.id === 'openai')
  assert.equal(openai.hint, 'sk-…ZZ99')
  assert.equal(openai.model, 'gpt-6-luna')
  assert.equal(state.primary, 'openai')
})

test('the chosen model goes first and the others are the fallback', async (t) => {
  const { store } = await makeStore(t)
  await store.addKey(OPENAI_KEY)
  await store.addKey(CLAUDE_KEY)
  assert.equal((await store.getPublicState()).primary, 'openai')

  await store.selectModel('anthropic', 'claude-sonnet-5-5')
  const plan = await store.getAgentPlan()
  assert.deepEqual(
    plan.map(({ provider, model }) => `${provider}:${model}`),
    ['anthropic:claude-sonnet-5-5', 'openai:gpt-6-luna']
  )
  assert.equal(plan[0].apiKey, CLAUDE_KEY)

  await store.removeProvider('anthropic')
  assert.equal((await store.getPublicState()).primary, 'openai')
})

test('Ollama joins only when turned on and reachable', async (t) => {
  const { store } = await makeStore(t)
  await store.configureOllama({ enabled: true, url: 'http://localhost:11434' })
  const state = await store.getPublicState()
  assert.equal(state.primary, 'ollama')
  assert.deepEqual(
    (await store.getAgentPlan()).map((entry) => entry.model),
    ['gemma2:2b']
  )
  await store.configureOllama({ enabled: false })
  assert.deepEqual(await store.getAgentPlan(), [])
})

test('unknown keys, refused keys and missing encryption save nothing', async (t) => {
  const { store } = await makeStore(t)
  await assert.rejects(store.addKey('minha-chave'), /Não reconheci/)

  const refused = await makeStore(t, {
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
  })
  await assert.rejects(refused.store.addKey(OPENAI_KEY), /recusou a chave/)
  assert.deepEqual(await refused.store.getAgentPlan(), [])

  const locked = await makeStore(t, { isAvailable: () => false })
  await assert.rejects(locked.store.addKey(OPENAI_KEY), /criptografia/)
})
