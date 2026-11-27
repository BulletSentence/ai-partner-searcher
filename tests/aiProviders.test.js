import assert from 'node:assert/strict'
import test from 'node:test'
import { detectProvider, listModels, maskKey, pickDefaultModel } from '../src/main/aiProviders.js'

test('recognises the provider from the key', () => {
  assert.equal(detectProvider('sk-ant-api03-' + 'a'.repeat(40)), 'anthropic')
  assert.equal(detectProvider('sk-proj-' + 'b'.repeat(40)), 'openai')
  assert.equal(detectProvider('  sk-' + 'c'.repeat(40) + '  '), 'openai')
  assert.equal(detectProvider('AIza' + 'd'.repeat(35)), 'gemini')
  assert.equal(detectProvider('chave-qualquer'), null)
  assert.equal(detectProvider(''), null)
})

test('masks keys so they can be told apart but not used', () => {
  assert.equal(maskKey('sk-ant-api03-' + 'a'.repeat(36) + 'WXYZ'), 'sk-ant-…WXYZ')
  assert.equal(maskKey('sk-proj-' + 'b'.repeat(36) + '1234'), 'sk-…1234')
  assert.equal(maskKey('AIza' + 'c'.repeat(31) + '9876'), 'AIza…9876')
  assert.equal(maskKey('curta'), '••••')
})

function fakeFetch(status, body, seen = []) {
  return async (url, options) => {
    seen.push({ url, headers: options.headers })
    return { ok: status < 400, status, json: async () => body }
  }
}

test('lists only the OpenAI models that write text, newest first', async () => {
  const seen = []
  const models = await listModels(
    'openai',
    { apiKey: 'sk-test' },
    fakeFetch(
      200,
      {
        data: [
          { id: 'gpt-4o-mini', created: 1 },
          { id: 'gpt-6-luna', created: 3 },
          { id: 'text-embedding-3-large', created: 4 },
          { id: 'gpt-4o-realtime-preview', created: 5 },
          { id: 'whisper-1', created: 6 },
          { id: 'o4-mini', created: 2 }
        ]
      },
      seen
    )
  )
  assert.deepEqual(models, ['gpt-6-luna', 'o4-mini', 'gpt-4o-mini'])
  assert.equal(seen[0].headers.Authorization, 'Bearer sk-test')
})

test('lists Gemini models that generate content and Ollama local models', async () => {
  const gemini = await listModels(
    'gemini',
    { apiKey: 'AIza-test' },
    fakeFetch(200, {
      models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        {
          name: 'models/gemini-2.5-flash-preview-tts',
          supportedGenerationMethods: ['generateContent']
        }
      ]
    })
  )
  assert.deepEqual(gemini, ['gemini-2.5-flash'])
  const seen = []
  const ollama = await listModels(
    'ollama',
    { url: 'http://localhost:11434/' },
    fakeFetch(200, { models: [{ name: 'gemma2:2b' }, { name: 'llama3.2:3b' }] }, seen)
  )
  assert.deepEqual(ollama, ['gemma2:2b', 'llama3.2:3b'])
  assert.equal(seen[0].url, 'http://localhost:11434/api/tags')
})

test('a rejected key becomes a clear message', async () => {
  await assert.rejects(
    listModels('anthropic', { apiKey: 'sk-ant-x' }, fakeFetch(401, {})),
    /recusou a chave \(401\)/
  )
  await assert.rejects(
    listModels('ollama', {}, async () => {
      throw new Error('connect ECONNREFUSED')
    }),
    /Não foi possível falar com Ollama/
  )
})

test('defaults to a fast model and keeps an earlier choice', () => {
  const claude = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
  assert.equal(pickDefaultModel('anthropic', claude), 'claude-haiku-5-5')
  assert.equal(pickDefaultModel('anthropic', claude, 'claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(pickDefaultModel('anthropic', claude, 'removido'), 'claude-haiku-5-5')
  assert.equal(
    pickDefaultModel('gemini', ['gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.5-flash']),
    'gemini-2.5-flash'
  )
  assert.equal(pickDefaultModel('openai', ['o4-mini', 'gpt-6-luna']), 'gpt-6-luna')
  assert.equal(pickDefaultModel('ollama', ['gemma2:2b']), 'gemma2:2b')
  assert.equal(pickDefaultModel('ollama', []), '')
})
