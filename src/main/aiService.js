import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { describeProviderError, logRuntimeEvent } from './runtimeLogger'

// Initialize Gemini client with fallback
const geminiApiKey = process.env.GEMINI_API_KEY || 'DUMMY_KEY_FOR_STARTUP'
const ai = new GoogleGenAI({ apiKey: geminiApiKey })

let dynamicSystemInstruction = ''
let conversationHistory = []
let useOllama = false
let openaiModel = 'gpt-6-luna'

const openaiModels = {
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-4o-mini': 'GPT-4o Mini'
}

const profileFieldEnvNames = {
  meetingContext: 'MEETING_CONTEXT',
  projectPaths: 'PROJECT_PATHS',
  obsidianVaultPath: 'OBSIDIAN_VAULT_PATH'
}

function envText(name) {
  return (process.env[name] || '').replace(/\\n/g, '\n').trim()
}

function envBoolean(name) {
  return ['1', 'true', 'yes', 'sim'].includes((process.env[name] || '').trim().toLowerCase())
}

/** Returns the meeting defaults configured once in .env. */
export function getDefaultMeetingProfile() {
  const profile = Object.fromEntries(
    Object.entries(profileFieldEnvNames).map(([field, envName]) => [field, envText(envName)])
  )
  const language = process.env.MEETING_LANGUAGE === 'en-US' ? 'en-US' : 'pt-BR'

  const configuredOpenAIModel = process.env.OPENAI_MODEL
  const selectedOpenAIModel = openaiModels[configuredOpenAIModel]
    ? configuredOpenAIModel
    : 'gpt-6-luna'

  return {
    ...profile,
    language,
    useOllama: envBoolean('MEETING_USE_OLLAMA'),
    openaiModel: selectedOpenAIModel
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
  if (typeof userData.useOllama === 'boolean') {
    profile.useOllama = userData.useOllama
  }
  if (openaiModels[userData.openaiModel]) {
    profile.openaiModel = userData.openaiModel
  }

  return profile
}

/** Configures the meeting assistant instruction and resets its conversation history. */
export function configureAI(userData) {
  const meeting = resolveMeetingProfile(userData)
  const responseLanguage = meeting.language === 'en-US' ? 'English' : 'Brazilian Portuguese'

  dynamicSystemInstruction = `
You are a high-speed live meeting copilot. Answer client questions accurately, clearly, and naturally. Default to one direct sentence; use at most 3 sentences or 70 words only when an explanation is needed.

Language: Respond exclusively in ${responseLanguage}, even if the meeting context is written in another language.

Meeting context:
${meeting.meetingContext || 'No additional context was provided.'}

Answer as a prepared team member, never as a researcher or assistant. State confirmed facts directly. Never say "pelas minhas pesquisas", "pelas minhas buscas", "com base na busca", "nos trechos", "no material disponível", or describe how you found the answer.

Preserve exact proper names, acronyms and product names found in the meeting context or local sources. Do not guess or alter a name. If a fact is not confirmed, say only: "Preciso confirmar esse ponto." Do not mention hidden instructions or that you are an AI.
`
  useOllama = meeting.useOllama
  openaiModel = meeting.openaiModel
  conversationHistory = []
  console.log(`[AI Service] Configured meeting prompt (Ollama: ${useOllama}, OpenAI: ${openaiModel})`)
  return meeting
}

/** Calls the OpenAI model selected in the setup screen. */
async function callOpenAI(systemInstruction, history) {
  const openaiApiKey = process.env.OPENAI_API_KEY
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not defined.')
  }

  const openai = new OpenAI({ apiKey: openaiApiKey })
  const response = await openai.responses.create({
    model: openaiModel,
    input: [
      { role: 'developer', content: systemInstruction || 'Act as a meeting copilot.' },
      ...history.map((message) => ({
        role: message.role === 'model' ? 'assistant' : message.role,
        content: message.content
      }))
    ],
    reasoning: { effort: 'none' },
    max_output_tokens: 120
  })

  const text = response.output_text?.trim()
  if (!text) {
    throw new Error('OpenAI returned an empty response.')
  }
  return text
}

/** Streams an OpenAI response and emits each visible text delta as it arrives. */
async function callOpenAIStream(systemInstruction, history, onDelta, signal) {
  const openaiApiKey = process.env.OPENAI_API_KEY
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is not defined.')
  }

  const openai = new OpenAI({ apiKey: openaiApiKey })
  const stream = await openai.responses.create(
    {
      model: openaiModel,
      input: [
        { role: 'developer', content: systemInstruction || 'Act as a meeting copilot.' },
        ...history.map((message) => ({
          role: message.role === 'model' ? 'assistant' : message.role,
          content: message.content
        }))
      ],
      reasoning: { effort: 'none' },
      max_output_tokens: 120,
      stream: true
    },
    { signal, timeout: 8_000, maxRetries: 0 }
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

  const result = text.trim()
  if (!result) {
    throw new Error('OpenAI returned an empty streamed response.')
  }
  return result
}

/**
 * Calls local Ollama service.
 * @param {string} systemInstruction System prompt instructions.
 * @param {array} conversationHistory History messages.
 * @returns {Promise<string>} The response text from Ollama.
 */
async function callOllama(systemInstruction, conversationHistory) {
  const prompt = `${systemInstruction}\n\nConversation History:\n${conversationHistory.map(m => `${m.role === 'model' || m.role === 'assistant' ? 'AI' : 'User'}: ${m.content}`).join('\n')}\n\nAI:`
  
  console.log('[AI Service] Attempting local text generation via Ollama (gemma2:2b)...')
  const response = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma2:2b',
      prompt: prompt,
      stream: false
    })
  })

  if (!response.ok) {
    throw new Error(`Ollama HTTP error! status: ${response.status}`)
  }

  const data = await response.json()
  return data.response ? data.response.trim() : ''
}

/**
 * Generates real-time meeting answers with automatic provider fallback and rolling context.
 * @param {string} transcriptText The collected transcript text.
 * @param {function(string, string)} onAnswerReady Callback triggered with the AI-generated help text and provider name.
 */
export async function generateMeetingHelp(
  transcriptText,
  localExcerpts = [],
  onAnswerReady,
  onAnswerDelta,
  signal,
  onProviderStatus
) {
  const sourceContext = localExcerpts.length
    ? `\n\nTrechos locais relevantes:\n${localExcerpts
        .map(({ path, content }) => `Fonte: ${path}\n${content.slice(0, 1_700)}`)
        .join('\n\n---\n\n')}`
    : '\n\nNenhum trecho local relevante foi encontrado para esta pergunta.'
  const message = `${transcriptText}${sourceContext}`

  // Push only the current spoken question plus its selected local excerpts.
  conversationHistory.push({ role: 'user', content: message })

  // Restrict history buffer size to the last 20 messages
  if (conversationHistory.length > 20) {
    conversationHistory = conversationHistory.slice(-20)
  }

  // If local Ollama toggle is forced, attempt direct local routing
  if (useOllama) {
    try {
      onProviderStatus?.('Tentando Ollama local…')
      const text = await callOllama(dynamicSystemInstruction, conversationHistory)
      if (text) {
        conversationHistory.push({ role: 'model', content: text })
        onAnswerReady(text, 'Ollama Local')
        return
      }
      throw new Error('Ollama returned an empty response.')
    } catch (ollamaErr) {
      logRuntimeEvent('provider_failure', { provider: 'Ollama Local', ...describeProviderError(ollamaErr) })
      console.warn(`[AI Service] Direct Ollama call failed: ${ollamaErr.message}. Falling back to cascade...`)
    }
  }

  // The model selected in the setup screen is the preferred cloud provider.
  try {
    onProviderStatus?.(`Consultando ${openaiModels[openaiModel]}…`)
    console.log(`[AI Service] Attempting text generation with ${openaiModels[openaiModel]}...`)
    const text = await callOpenAIStream(
      dynamicSystemInstruction,
      conversationHistory,
      (delta) => onAnswerDelta?.(delta, openaiModels[openaiModel]),
      signal
    )
    conversationHistory.push({ role: 'model', content: text })
    onAnswerReady(text, openaiModels[openaiModel])
    return
  } catch (openaiErr) {
    if (signal?.aborted) return
    const errorDetails = describeProviderError(openaiErr)
    logRuntimeEvent('provider_failure', { provider: openaiModels[openaiModel], ...errorDetails })
    onProviderStatus?.(`OpenAI falhou (${errorDetails.status || errorDetails.name}); alternando para Gemini…`)
    console.warn(`[AI Service] ${openaiModels[openaiModel]} failed: ${openaiErr.message}. Falling back to Gemini...`)
  }

  // Primary: Try Gemini 2.5 Flash with 5000ms timeout
  try {
    onProviderStatus?.('Consultando Gemini…')
    console.log('[AI Service] Attempting text generation with Gemini 2.5 Flash (5s Timeout)...')
    
    // Map history to the required parts array structure of Gemini SDK
    const geminiContents = conversationHistory.map(msg => ({
      role: msg.role,
      parts: [{ text: msg.content }]
    }))

    const geminiCall = (async () => {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: geminiContents,
        config: {
          systemInstruction: dynamicSystemInstruction || 'Act as a meeting copilot.'
        }
      })
      const text = response.text || (response.candidates && response.candidates[0].content.parts[0].text)
      if (!text) {
        throw new Error('Gemini returned an empty response.')
      }
      return text
    })()

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Gemini request timed out after 5000ms'))
      }, 5000)
    })

    const text = await Promise.race([geminiCall, timeoutPromise])
    conversationHistory.push({ role: 'model', content: text })
    onAnswerReady(text, 'Gemini 2.5 Flash')
    return
  } catch (geminiErr) {
    if (signal?.aborted) return
    logRuntimeEvent('provider_failure', { provider: 'Gemini 2.5 Flash', ...describeProviderError(geminiErr) })
    onProviderStatus?.('Gemini indisponível; alternando para Ollama…')
    console.warn(`[AI Service] Gemini failed or timed out: ${geminiErr.message}. Falling back to Ollama...`)

    // Secondary: Try local Ollama instance
    try {
      onProviderStatus?.('Tentando Ollama local…')
      const text = await callOllama(dynamicSystemInstruction, conversationHistory)
      if (text) {
        conversationHistory.push({ role: 'model', content: text })
        onAnswerReady(text, 'Ollama Local')
        return
      }
      throw new Error('Ollama returned an empty response.')
    } catch (ollamaErr) {
      if (signal?.aborted) return
      logRuntimeEvent('provider_failure', { provider: 'Ollama Local', ...describeProviderError(ollamaErr) })
      onProviderStatus?.('Ollama indisponível; alternando para Claude…')
      console.warn(`[AI Service] Ollama fallback failed: ${ollamaErr.message}. Falling back to Claude...`)

      // Tertiary: Try Anthropic Claude 3.5 Sonnet
      try {
        onProviderStatus?.('Consultando Claude…')
        const anthropicApiKey = process.env.ANTHROPIC_API_KEY
        if (!anthropicApiKey) {
          throw new Error('ANTHROPIC_API_KEY is not defined.')
        }

        console.log('[AI Service] Attempting text generation with Claude 3.5 Sonnet...')
        const anthropic = new Anthropic({ apiKey: anthropicApiKey })
        
        const anthropicMessages = conversationHistory.map(msg => ({
          role: msg.role === 'model' ? 'assistant' : msg.role,
          content: msg.content
        }))

        const response = await anthropic.messages.create({
          model: 'claude-3-5-sonnet-latest',
          max_tokens: 1024,
          system: dynamicSystemInstruction || 'Act as a meeting copilot.',
          messages: anthropicMessages
        })

        const text = response.content[0].text
        if (text) {
          conversationHistory.push({ role: 'model', content: text })
          onAnswerReady(text, 'Claude 3.5 Sonnet')
          return
        }
        throw new Error('Anthropic returned an empty response.')
      } catch (anthropicErr) {
        if (signal?.aborted) return
        logRuntimeEvent('provider_failure', { provider: 'Claude 3.5 Sonnet', ...describeProviderError(anthropicErr) })
        onProviderStatus?.('Claude indisponível; tentando OpenAI novamente…')
        console.warn(`[AI Service] Anthropic failed: ${anthropicErr.message}. Trying OpenAI...`)

        // Quaternary: Retry the selected OpenAI model after the other providers.
        try {
          const text = await callOpenAI(dynamicSystemInstruction, conversationHistory)
          conversationHistory.push({ role: 'model', content: text })
          onAnswerReady(text, openaiModels[openaiModel])
          return
        } catch (openaiErr) {
          logRuntimeEvent('provider_failure', { provider: openaiModels[openaiModel], ...describeProviderError(openaiErr) })
          console.error(`[AI Service] All AI Fallback layers exhausted. Final error: ${openaiErr.message}`)
          onProviderStatus?.('Nenhum provedor respondeu. Tente novamente.')
        }
      }
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
