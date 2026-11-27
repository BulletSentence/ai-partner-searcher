import fs from 'fs/promises'
import { dirname } from 'path'
import {
  DEFAULT_OLLAMA_URL,
  FALLBACK_ORDER,
  PROVIDERS,
  detectProvider,
  listModels,
  maskKey,
  pickDefaultModel
} from './aiProviders.js'

const CLOUD = ['openai', 'anthropic', 'gemini']

function emptyState() {
  return {
    providers: { ollama: { enabled: false, url: DEFAULT_OLLAMA_URL, models: [], model: '' } },
    primary: null
  }
}

/**
 * Keeps the API keys and the agent choice in one file encrypted as a whole: keys, chosen models
 * and the Ollama address never touch the disk in plain text, and no key ever goes back to the
 * screen, only its masked form.
 *
 * `encrypt`/`decrypt` turn a string into a Buffer and back (Electron's safeStorage in the app).
 */
export function createProviderStore({
  filePath,
  encrypt,
  decrypt,
  isAvailable = () => true,
  fetchImpl = fetch
}) {
  let state = null

  async function load() {
    if (state) return state
    try {
      state = { ...emptyState(), ...JSON.parse(decrypt(await fs.readFile(filePath))) }
      state.providers = { ...emptyState().providers, ...state.providers }
    } catch (error) {
      if (error.code !== 'ENOENT')
        console.warn(`[Providers] Could not read the saved providers: ${error.message}`)
      state = emptyState()
    }
    return state
  }

  async function save() {
    if (!isAvailable())
      throw new Error('A criptografia do sistema não está disponível; a chave não foi salva.')
    await fs.mkdir(dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.tmp`
    await fs.writeFile(tempPath, encrypt(JSON.stringify(state)), { mode: 0o600 })
    await fs.rename(tempPath, filePath)
  }

  function configured(current, id) {
    const entry = current.providers[id]
    if (!entry) return false
    return id === 'ollama'
      ? entry.enabled && Boolean(entry.model)
      : Boolean(entry.apiKey && entry.model)
  }

  // A choice that no longer works (key removed, Ollama turned off) falls to the next provider.
  function repairPrimary(current) {
    if (current.primary && configured(current, current.primary)) return
    current.primary = FALLBACK_ORDER.find((id) => configured(current, id)) || null
  }

  /** What the screen may see: no keys, only which providers are ready and their models. */
  async function getPublicState() {
    const current = await load()
    return {
      encryptionAvailable: isAvailable(),
      primary: current.primary,
      providers: FALLBACK_ORDER.map((id) => {
        const entry = current.providers[id] || {}
        return {
          id,
          label: PROVIDERS[id].label,
          short: PROVIDERS[id].short,
          configured: configured(current, id),
          hint: entry.hint || '',
          models: entry.models || [],
          model: entry.model || '',
          ...(id === 'ollama'
            ? { enabled: Boolean(entry.enabled), url: entry.url || DEFAULT_OLLAMA_URL }
            : {})
        }
      })
    }
  }

  /** Checks a pasted key against its provider and keeps it only when the provider accepts it. */
  async function addKey(rawKey) {
    const apiKey = String(rawKey || '').trim()
    const provider = detectProvider(apiKey)
    if (!provider) {
      throw new Error(
        'Não reconheci essa chave. Use uma chave da OpenAI (sk-…), da Anthropic (sk-ant-…) ou do Google Gemini (AIza…).'
      )
    }
    if (!isAvailable())
      throw new Error('A criptografia do sistema não está disponível; a chave não foi salva.')
    const models = await listModels(provider, { apiKey }, fetchImpl)
    if (!models.length)
      throw new Error(
        `A chave funciona, mas ${PROVIDERS[provider].short} não liberou nenhum modelo de texto para ela.`
      )
    const current = await load()
    const previous = current.providers[provider]?.model
    current.providers[provider] = {
      apiKey,
      hint: maskKey(apiKey),
      models,
      model: pickDefaultModel(provider, models, previous)
    }
    // The first key added becomes the agent; adding more keeps the current choice.
    repairPrimary(current)
    await save()
    return { provider, models: models.length }
  }

  async function removeProvider(id) {
    const current = await load()
    if (id === 'ollama') current.providers.ollama = { ...current.providers.ollama, enabled: false }
    else delete current.providers[id]
    repairPrimary(current)
    await save()
  }

  /** The model the agent answers with; choosing it also makes its provider the first one tried. */
  async function selectModel(id, model) {
    const current = await load()
    const entry = current.providers[id]
    if (!entry || !entry.models?.includes(model)) throw new Error('Modelo indisponível.')
    entry.model = model
    current.primary = id
    if (!configured(current, id)) throw new Error(`${PROVIDERS[id].short} não está configurado.`)
    await save()
  }

  async function refreshModels(id) {
    const current = await load()
    const entry = current.providers[id]
    if (!entry) throw new Error('Provedor não configurado.')
    const models = await listModels(id, { apiKey: entry.apiKey, url: entry.url }, fetchImpl)
    entry.models = models
    entry.model = pickDefaultModel(id, models, entry.model)
    repairPrimary(current)
    await save()
    return { models: models.length }
  }

  /** Turns the local Ollama on or off; turning it on also reads which models it has. */
  async function configureOllama({ enabled, url } = {}) {
    const current = await load()
    const entry = current.providers.ollama
    if (typeof url === 'string' && url.trim()) entry.url = url.trim()
    entry.enabled = Boolean(enabled)
    let error = null
    if (entry.enabled) {
      try {
        entry.models = await listModels('ollama', { url: entry.url }, fetchImpl)
        entry.model = pickDefaultModel('ollama', entry.models, entry.model)
        if (!entry.models.length)
          error = 'O Ollama respondeu, mas não tem nenhum modelo baixado (use ollama pull).'
      } catch (listError) {
        error = listError.message
      }
    }
    repairPrimary(current)
    await save()
    if (error) throw new Error(error)
  }

  /** Only for the main process: the providers to try, the chosen one first, with their secrets. */
  async function getAgentPlan() {
    const current = await load()
    repairPrimary(current)
    const order = current.primary
      ? [current.primary, ...FALLBACK_ORDER.filter((id) => id !== current.primary)]
      : FALLBACK_ORDER
    return order
      .filter((id) => configured(current, id))
      .map((id) => {
        const entry = current.providers[id]
        return {
          provider: id,
          model: entry.model,
          apiKey: entry.apiKey || '',
          url: entry.url || ''
        }
      })
  }

  return {
    getPublicState,
    addKey,
    removeProvider,
    selectModel,
    refreshModels,
    configureOllama,
    getAgentPlan,
    isCloud: (id) => CLOUD.includes(id)
  }
}
