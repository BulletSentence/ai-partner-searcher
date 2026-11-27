// Which provider an API key belongs to, and which of its models can answer in a meeting.
// Only plain HTTP calls here, so the logic can be tested without the SDKs or Electron.

export const PROVIDERS = {
  openai: { label: 'OpenAI', short: 'OpenAI' },
  anthropic: { label: 'Claude (Anthropic)', short: 'Claude' },
  gemini: { label: 'Gemini (Google)', short: 'Gemini' },
  ollama: { label: 'Ollama local', short: 'Ollama' }
}

// The order used when the chosen provider fails and the next one is tried.
export const FALLBACK_ORDER = ['openai', 'anthropic', 'gemini', 'ollama']

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'
const LIST_TIMEOUT_MS = 10_000

/** Recognises the provider from the shape of the key; null when it is not one we know. */
export function detectProvider(rawKey = '') {
  const key = String(rawKey).trim()
  if (/^sk-ant-[\w-]{10,}$/.test(key)) return 'anthropic'
  if (/^sk-[\w-]{20,}$/.test(key)) return 'openai'
  if (/^AIza[\w-]{30,}$/.test(key)) return 'gemini'
  return null
}

/** Enough of the key to tell two apart, never enough to use it. */
export function maskKey(rawKey = '') {
  const key = String(rawKey).trim()
  if (key.length < 12) return '••••'
  const prefix = key.startsWith('sk-ant-')
    ? 'sk-ant-'
    : key.startsWith('sk-')
      ? 'sk-'
      : key.slice(0, 4)
  return `${prefix}…${key.slice(-4)}`
}

// OpenAI lists every model it has; only the ones that write text answers are useful here.
const OPENAI_CHAT = /^(gpt-|chatgpt-|o\d)/
const OPENAI_NOT_CHAT =
  /(audio|realtime|tts|transcribe|image|search|embedding|instruct|codex|moderation|dall-e|whisper|computer-use)/
const GEMINI_NOT_CHAT = /(embedding|tts|image|aqa|live|native-audio|imagen|veo)/

async function getJson(fetchImpl, url, headers, providerLabel) {
  let response
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
  } catch (error) {
    throw new Error(
      `Não foi possível falar com ${providerLabel} (${error.name === 'TimeoutError' ? 'tempo esgotado' : error.message}).`
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${providerLabel} recusou a chave (${response.status}). Confira se ela está ativa.`
    )
  }
  if (!response.ok) throw new Error(`${providerLabel} respondeu com erro ${response.status}.`)
  return response.json()
}

/**
 * Lists the models the key (or the local Ollama) can use, newest first. Doubles as the check
 * that a pasted key really works.
 */
export async function listModels(
  provider,
  { apiKey = '', url = DEFAULT_OLLAMA_URL } = {},
  fetchImpl = fetch
) {
  const label = PROVIDERS[provider]?.short || provider
  if (provider === 'openai') {
    const body = await getJson(
      fetchImpl,
      'https://api.openai.com/v1/models',
      { Authorization: `Bearer ${apiKey}` },
      label
    )
    return (body.data || [])
      .filter(({ id }) => OPENAI_CHAT.test(id) && !OPENAI_NOT_CHAT.test(id))
      .sort((first, second) => (second.created || 0) - (first.created || 0))
      .map(({ id }) => id)
  }
  if (provider === 'anthropic') {
    const body = await getJson(
      fetchImpl,
      'https://api.anthropic.com/v1/models?limit=1000',
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      label
    )
    return (body.data || []).map(({ id }) => id)
  }
  if (provider === 'gemini') {
    const body = await getJson(
      fetchImpl,
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      { 'x-goog-api-key': apiKey },
      label
    )
    return (body.models || [])
      .filter(
        (model) =>
          (model.supportedGenerationMethods || []).includes('generateContent') &&
          /gemini/.test(model.name) &&
          !GEMINI_NOT_CHAT.test(model.name)
      )
      .map((model) => model.name.replace(/^models\//, ''))
  }
  if (provider === 'ollama') {
    const base = String(url || DEFAULT_OLLAMA_URL).replace(/\/+$/, '')
    const body = await getJson(fetchImpl, `${base}/api/tags`, {}, label)
    return (body.models || []).map((model) => model.name)
  }
  throw new Error('Provedor desconhecido.')
}

// Live answers need speed more than depth: the fast model of each family comes first.
const PREFERRED = {
  openai: [/^gpt-6-luna$/, /^gpt-[\d.]+-mini$/, /^gpt-/],
  anthropic: [/haiku/, /sonnet/],
  gemini: [/flash(?!.*lite)/, /flash/],
  ollama: []
}

/** Keeps the previous choice when it still exists; otherwise picks a fast model of the provider. */
export function pickDefaultModel(provider, models = [], previous = '') {
  if (previous && models.includes(previous)) return previous
  for (const pattern of PREFERRED[provider] || []) {
    const match = models.find((model) => pattern.test(model))
    if (match) return match
  }
  return models[0] || ''
}
