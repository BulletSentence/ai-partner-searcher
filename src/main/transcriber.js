import { spawn } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { logRuntimeEvent } from './runtimeLogger'

const executableName = process.platform === 'win32' ? 'whisper-stream.exe' : 'whisper-stream'
const bundledBinary = join(process.resourcesPath || process.cwd(), 'bin', executableName)
const developmentBinary = join(process.cwd(), 'bin', executableName)
const bundledModelsDirectory = join(process.resourcesPath || process.cwd(), 'models')
const modelsDirectory =
  process.env.WHISPER_MODELS_DIR ||
  (existsSync(bundledModelsDirectory) ? bundledModelsDirectory : join(process.cwd(), 'models'))
const STOP_TIMEOUT_MS = 8_000
const MAX_PROMPT_CHARS = 700

/** Audio channels understood by the adapter: who is speaking is known from where the audio came from. */
export const CHANNEL_CLIENT = 0
export const CHANNEL_ME = 1

let child = null
let handlers = {}
let currentSignature = null
let currentPrompt = ''
let outputBuffer = ''
let currentLanguage = 'pt-BR'

/** Path of the Whisper.cpp adapter executable, or null when it has not been built. */
export function getWhisperBinary() {
  if (process.env.WHISPER_CPP_BIN) return process.env.WHISPER_CPP_BIN
  if (existsSync(bundledBinary)) return bundledBinary
  if (existsSync(developmentBinary)) return developmentBinary
  return null
}

/** Returns setup data that can be shown before a meeting begins. */
export function getTranscriberStatus() {
  const binaryPath = getWhisperBinary()
  const models = listTranscriptionModels()
  return {
    ready: Boolean(binaryPath) && models.length > 0,
    binaryFound: Boolean(binaryPath),
    modelsFound: models.length,
    modelsDirectory
  }
}

function isWhisperModel(entry) {
  return entry.isFile() && /\.(bin|gguf)$/i.test(entry.name)
}

/** Lists Whisper.cpp model files available in ./models. */
export function listTranscriptionModels() {
  try {
    return readdirSync(modelsDirectory, { withFileTypes: true })
      .filter(isWhisperModel)
      .map((entry) => ({
        id: entry.name,
        label: entry.name.replace(/^ggml-/, '').replace(/\.(bin|gguf)$/i, '')
      }))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[Transcriber] Could not list Whisper models: ${error.message}`)
      logRuntimeEvent('transcriber_models_list_failed', {
        code: error.code,
        message: error.message
      })
    }
    return []
  }
}

/**
 * The Silero voice-detection model used to decide where speech starts and stops. Without it the
 * adapter falls back to loudness, which mistakes steady noise and keyboard clicks for speech.
 */
export function getVadModelPath() {
  if (process.env.WHISPER_VAD_MODEL) return process.env.WHISPER_VAD_MODEL
  const directory = join(modelsDirectory, 'vad')
  try {
    const file = readdirSync(directory).find((name) => /silero.*\.bin$/i.test(name))
    return file ? join(directory, file) : null
  } catch {
    return null
  }
}

/** Absolute path of a model file from the models folder, or null when it is not there. */
export function resolveTranscriptionModel(modelFile) {
  if (!modelFile) return null
  const modelPath = join(modelsDirectory, modelFile)
  return existsSync(modelPath) ? modelPath : null
}

function languageCode(language) {
  return language === 'en-US' ? 'en' : 'pt'
}

/**
 * Builds the decoder prompt that tells Whisper which words to expect. Proper names and acronyms
 * listed here are recognised far more reliably than when they are fixed afterwards by text replacement.
 */
export function buildWhisperPrompt({ meetingContext = '', terms = [], language = 'pt-BR' } = {}) {
  const isEnglish = language === 'en-US'
  const context = meetingContext
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
    .replace(/[.\s]+$/, '')
  // "Reunião do FIDC" already reads as a sentence; anything else gets an introduction.
  const hasOpening = /^(reuni[ãa]o|meeting|call|daily|alinhamento)\b/iu.test(context)
  const opening = hasOpening ? '' : isEnglish ? 'Meeting about ' : 'Reunião sobre '
  const intro = context ? `${opening}${context}. ` : ''
  const label = isEnglish ? 'Terms used: ' : 'Termos usados: '
  const selected = []
  let length = intro.length + label.length
  for (const term of [...new Set(terms.map((value) => value.trim()).filter(Boolean))]) {
    if (length + term.length + 2 > MAX_PROMPT_CHARS) break
    selected.push(term)
    length += term.length + 2
  }
  if (!selected.length) return intro.trim()
  return `${intro}${label}${selected.join(', ')}.`
}

/** The prompt given to the running adapter, used to recognise when Whisper merely echoes it back. */
export function getTranscriberPrompt() {
  return currentPrompt
}

function handleChildMessage(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    console.warn(`[Transcriber] Ignoring malformed Whisper message: ${line}`)
    return
  }
  if (message.type === 'ready') {
    console.log(`[Transcriber] Whisper model loaded (voice detection: ${message.vad || 'energy'}).`)
    handlers.onReady?.()
    return
  }
  if (typeof message.text !== 'string' || !message.text.trim()) return
  const utterance = {
    channel: message.channel === CHANNEL_ME ? CHANNEL_ME : CHANNEL_CLIENT,
    text: message.text.trim(),
    startMs: Number(message.t0) || 0,
    endMs: Number(message.t1) || 0,
    noSpeechProbability: Number(message.nsp) || 0,
    confidence: typeof message.p === 'number' ? message.p : 1,
    decodeMs: Number(message.ms) || 0
  }
  if (message.type === 'final') handlers.onFinal?.(utterance)
  else if (message.type === 'partial') handlers.onPartial?.(utterance)
}

/** Registers the callbacks that receive live (`onPartial`) and completed (`onFinal`) utterances. */
export function setTranscriptionHandlers(nextHandlers = {}) {
  handlers = nextHandlers
}

/** Starts the bundled Whisper.cpp streaming adapter for the chosen local model. */
export function configureTranscriber(
  language = 'pt-BR',
  requestedModel = '',
  { prompt = '' } = {}
) {
  currentLanguage = language
  const models = listTranscriptionModels()
  const modelFile = requestedModel || models[0]?.id
  const modelPath = modelFile && join(modelsDirectory, modelFile)
  const whisperBinary = getWhisperBinary()

  if (!modelPath || !existsSync(modelPath)) {
    console.error(`[Transcriber] Whisper model not found: ${modelFile || '(none)'}`)
    logRuntimeEvent('transcriber_model_missing', { language, modelFile, modelsDirectory })
    return false
  }
  if (!whisperBinary) {
    console.error('[Transcriber] whisper-stream executable was not found.')
    logRuntimeEvent('transcriber_binary_missing', { executableName })
    return false
  }
  const signature = JSON.stringify([modelPath, language, prompt])
  if (child && currentSignature === signature) return true
  if (child) child.kill()

  currentSignature = signature
  currentPrompt = prompt
  outputBuffer = ''
  console.log(`[Transcriber] Starting Whisper.cpp with ${modelFile}`)
  const args = ['--model', modelPath, '--language', languageCode(language)]
  if (prompt) args.push('--prompt', prompt)
  const vadModel = getVadModelPath()
  if (vadModel) args.push('--vad-model', vadModel)
  if (process.env.WHISPER_BEAM_SIZE) args.push('--beam', process.env.WHISPER_BEAM_SIZE)
  const spawnedChild = spawn(whisperBinary, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  child = spawnedChild
  spawnedChild.stdout.on('data', (data) => {
    outputBuffer += data.toString()
    const lines = outputBuffer.split('\n')
    outputBuffer = lines.pop() || ''
    lines.filter(Boolean).forEach(handleChildMessage)
  })
  spawnedChild.on('error', (err) => {
    console.error(`[Transcriber] Whisper process error: ${err.message}`)
    logRuntimeEvent('transcriber_process_error', { code: err.code, message: err.message })
  })
  spawnedChild.stdin.on('error', (err) => {
    console.error(`[Transcriber] Whisper input error: ${err.message}`)
    logRuntimeEvent('transcriber_input_error', { code: err.code, message: err.message })
  })
  spawnedChild.on('close', (code) => {
    if (code !== 0 && code !== null)
      logRuntimeEvent('transcriber_process_closed', { code, modelFile })
    if (child === spawnedChild) {
      child = null
      currentSignature = null
    }
  })
  return true
}

/** Feeds 16 kHz signed-16-bit mono PCM from one channel (client or meeting owner) to Whisper.cpp. */
export function processAudioStream(data, channel = CHANNEL_CLIENT) {
  if (!child && !configureTranscriber(currentLanguage)) return
  if (!child?.stdin?.writable || child.stdin.destroyed || child.stdin.writableEnded) return
  const header = Buffer.alloc(5)
  header.writeUInt8(channel === CHANNEL_ME ? CHANNEL_ME : CHANNEL_CLIENT, 0)
  header.writeUInt32LE(data.length, 1)
  child.stdin.write(header)
  child.stdin.write(data)
}

/**
 * Closes the audio input and waits for Whisper to transcribe what is still buffered, so the last
 * sentence of the meeting reaches the saved transcript. Resolves once the process has exited.
 */
export function stopTranscriber() {
  const stoppingChild = child
  child = null
  currentSignature = null
  if (!stoppingChild) return Promise.resolve()

  return new Promise((resolve) => {
    const timeout = setTimeout(() => stoppingChild.kill(), STOP_TIMEOUT_MS)
    stoppingChild.once('close', () => {
      clearTimeout(timeout)
      if (outputBuffer.trim()) handleChildMessage(outputBuffer.trim())
      outputBuffer = ''
      resolve()
    })
    try {
      stoppingChild.stdin.end()
    } catch {
      stoppingChild.kill()
    }
  })
}
