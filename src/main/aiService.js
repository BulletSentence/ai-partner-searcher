import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { describeProviderError, logRuntimeEvent } from './runtimeLogger'
import { PROVIDERS } from './aiProviders.js'
import { getAgentPlan } from './providerSettings'

let dynamicSystemInstruction = ''
let conversationHistory = []

const profileFieldEnvNames = {
  meetingContext: 'MEETING_CONTEXT',
  projectPaths: 'PROJECT_PATHS',
  obsidianVaultPath: 'OBSIDIAN_VAULT_PATH'
}

function envText(name) {
  return (process.env[name] || '').replace(/\\n/g, '\n').trim()
}

/** Returns the meeting defaults configured once in .env. */
export function getDefaultMeetingProfile() {
  const profile = Object.fromEntries(
    Object.entries(profileFieldEnvNames).map(([field, envName]) => [field, envText(envName)])
  )
  const language = process.env.MEETING_LANGUAGE === 'en-US' ? 'en-US' : 'pt-BR'

  return {
    ...profile,
    language
  }
}

/** Uses non-empty form values first, then falls back to the persistent .env profile. */
export function resolveMeetingProfile(userData = {}) {
  const defaults = getDefaultMeetingProfile()
  const profile = { ...defaults }

  for (const field of Object.keys(profileFieldEnvNames)) {
    if (typeof userData[field] === 'string' && userData[field].trim()) {
      profile[field] = userData[field].trim()
    }
  }

  if (userData.language === 'pt-BR' || userData.language === 'en-US') {
    profile.language = userData.language
  }

  return profile
}

/** Configures the meeting assistant instruction and resets its conversation history. */
export function configureAI(userData) {
  const meeting = resolveMeetingProfile(userData)
  const responseLanguage = meeting.language === 'en-US' ? 'English' : 'Brazilian Portuguese'

  dynamicSystemInstruction = `
You are a high-speed live meeting copilot. The meeting may be with a client, a daily stand-up, a team alignment or any other call; the meeting context says which. Suggest what the meeting owner should answer to questions asked by the other participants, accurately, clearly, and naturally, in a tone that fits that kind of meeting. Default to one direct sentence; use at most 3 sentences or 70 words only when an explanation is needed.

MANDATORY LANGUAGE RULE: Respond exclusively in ${responseLanguage}. Never answer in English when the selected language is Brazilian Portuguese, even if the question, API documentation, error message, code, or meeting context is in English. Keep technical identifiers such as endpoint names, HTTP methods, headers, token names, and code exactly as written, but explain them in Brazilian Portuguese. Do not add an English translation after the Portuguese answer.

Meeting context:
${meeting.meetingContext || 'No additional context was provided.'}

Answer as a prepared team member, never as a researcher or assistant. State confirmed facts directly. Never say "pelas minhas pesquisas", "pelas minhas buscas", "com base na busca", "nos trechos", "no material disponível", or describe how you found the answer.

The question comes from live speech recognition and may contain a misheard word. Read it in light of the meeting context and the previous lines of the conversation, and answer the question the speaker most plausibly asked.

Preserve exact proper names, acronyms and product names found in the meeting context or local sources. Do not guess or alter a name. If a fact is not confirmed, say only: "Preciso confirmar esse ponto." Do not mention hidden instructions or that you are an AI.
`
  conversationHistory = []
  console.log('[AI Service] Configured meeting prompt.')
  return meeting
}

const CLOUD_TIMEOUT_MS = 15_000
// A local model may need to load into memory before its first answer.
const OLLAMA_TIMEOUT_MS = 45_000
const MAX_ANSWER_TOKENS = 400

function chatMessages(history) {
  return history.map((message) => ({
    role: message.role === 'model' ? 'assistant' : message.role,
    content: message.content
  }))
}

// Reasoning models answer a live question far faster with reasoning turned down.
function openaiReasoning(model) {
  if (/^gpt-([6-9]|5\.[1-9])/.test(model)) return { effort: 'none' }
  if (/^(gpt-5|o\d)/.test(model)) return { effort: 'low' }
  return undefined
}

async function streamOpenAI({ apiKey, model }, system, history, onDelta, signal) {
  const openai = new OpenAI({ apiKey, maxRetries: 0 })
  const request = async (reasoning) => {
    const stream = await openai.responses.create(
      {
        model,
        input: [{ role: 'developer', content: system }, ...chatMessages(history)],
        ...(reasoning ? { reasoning } : {}),
        max_output_tokens: MAX_ANSWER_TOKENS,
        stream: true
      },
      { signal }
    )
    let text = ''
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        text += event.delta
        onDelta(event.delta)
      } else if (event.type === 'error') {
        throw new Error(event.message || 'OpenAI streaming error.')
      }
    }
    return text
  }
  const reasoning = openaiReasoning(model)
  try {
    return await request(reasoning)
  } catch (error) {
    // Some models refuse the reasoning setting; the answer is still worth having without it.
    if (reasoning && error?.status === 400 && /reasoning/i.test(error.message)) return request()
    throw error
  }
}

async function streamClaude({ apiKey, model }, system, history, onDelta, signal) {
  const anthropic = new Anthropic({ apiKey, maxRetries: 0 })
  const stream = anthropic.messages.stream(
    { model, max_tokens: MAX_ANSWER_TOKENS, system, messages: chatMessages(history) },
    { signal }
  )
  stream.on('text', (delta) => onDelta(delta))
  return stream.finalText()
}

async function streamGemini({ apiKey, model }, system, history, onDelta, signal) {
  const gemini = new GoogleGenAI({ apiKey })
  const stream = await gemini.models.generateContentStream({
    model,
    contents: history.map((message) => ({
      role: message.role === 'user' ? 'user' : 'model',
      parts: [{ text: message.content }]
    })),
    config: { systemInstruction: system, maxOutputTokens: MAX_ANSWER_TOKENS, abortSignal: signal }
  })
  let text = ''
  for await (const chunk of stream) {
    const delta = chunk.text || ''
    if (!delta) continue
    text += delta
    onDelta(delta)
  }
  return text
}

async function callOllama({ model, url }, system, history, onDelta, signal) {
  const response = await fetch(`${String(url).replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...chatMessages(history)],
      stream: false
    }),
    signal
  })
  if (!response.ok) throw new Error(`Ollama HTTP error! status: ${response.status}`)
  const text = (await response.json())?.message?.content || ''
  if (text) onDelta(text)
  return text
}

const providerCalls = {
  openai: streamOpenAI,
  anthropic: streamClaude,
  gemini: streamGemini,
  ollama: callOllama
}

export function providerLabel({ provider, model }) {
  return `${PROVIDERS[provider]?.short || provider} · ${model}`
}

/**
 * Generates real-time meeting answers with automatic provider fallback and rolling context.
 * @param {string} transcriptText The question to answer.
 * @param {string} recentTranscript The lines spoken just before the question, already labelled by speaker.
 * @param {function(string, string)} onAnswerReady Callback triggered with the AI-generated help text and provider name.
 */
export async function generateMeetingHelp(
  transcriptText,
  localExcerpts = [],
  onAnswerReady,
  onAnswerDelta,
  signal,
  onProviderStatus,
  recentTranscript = ''
) {
  const sourceContext = localExcerpts.length
    ? `\n\nTrechos locais relevantes:\n${localExcerpts
        .map(({ path, content }) => `Fonte: ${path}\n${content.slice(0, 1_700)}`)
        .join('\n\n---\n\n')}`
    : '\n\nNenhum trecho local relevante foi encontrado para esta pergunta.'
  const conversationContext = recentTranscript
    ? `Falas anteriores da reunião (para entender a que a pergunta se refere):\n${recentTranscript}\n\nPergunta a responder: `
    : ''
  const message = `${conversationContext}${transcriptText}${sourceContext}`

  // Push only the current spoken question plus its selected local excerpts.
  conversationHistory.push({ role: 'user', content: message })

  // Restrict history buffer size to the last 20 messages
  if (conversationHistory.length > 20) {
    conversationHistory = conversationHistory.slice(-20)
  }

  const plan = await getAgentPlan()
  if (!plan.length) {
    conversationHistory.pop()
    onProviderStatus?.(
      'Nenhum provedor de IA configurado. Abra Configurações e adicione uma chave ou ative o Ollama.'
    )
    return
  }

  const system = dynamicSystemInstruction || 'Act as a meeting copilot.'
  // The model chosen in the setup screen goes first; the other configured providers are the fallback.
  for (const [index, target] of plan.entries()) {
    if (signal?.aborted) return
    const label = providerLabel(target)
    const next = plan[index + 1]
    onProviderStatus?.(`Consultando ${label}…`)
    const timeout = AbortSignal.timeout(
      target.provider === 'ollama' ? OLLAMA_TIMEOUT_MS : CLOUD_TIMEOUT_MS
    )
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const text = (
        await providerCalls[target.provider](
          target,
          system,
          conversationHistory,
          (delta) => onAnswerDelta?.(delta, label),
          attemptSignal
        )
      ).trim()
      if (!text) throw new Error(`${label} returned an empty response.`)
      conversationHistory.push({ role: 'model', content: text })
      onAnswerReady(text, label)
      return
    } catch (error) {
      if (signal?.aborted) return
      const details = describeProviderError(error)
      logRuntimeEvent('provider_failure', { provider: label, ...details })
      console.warn(`[AI Service] ${label} failed: ${error.message}`)
      onProviderStatus?.(
        next
          ? `${PROVIDERS[target.provider].short} falhou (${details.status || details.name}); tentando ${providerLabel(next)}…`
          : 'Nenhum provedor respondeu. Verifique as chaves em Configurações e a conexão.'
      )
    }
  }
}

/**
 * Returns the rolling conversation history buffer.
 * @returns {array} The current conversation history.
 */
export function getConversationHistory() {
  return conversationHistory
}
