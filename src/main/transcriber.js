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
let child = null
let sentenceCallback = null
let currentModelPath = null
let outputBuffer = ''
let currentLanguage = 'pt-BR'

function getWhisperBinary() {
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

function languageCode(language) {
  return language === 'en-US' ? 'en' : 'pt'
}

function handleChildMessage(line) {
  try {
    const message = JSON.parse(line)
    if (
      message.type === 'final' &&
      typeof message.text === 'string' &&
      message.text.trim() &&
      sentenceCallback
    ) {
      sentenceCallback(message.text.trim())
    }
  } catch {
    console.warn(`[Transcriber] Ignoring malformed Whisper message: ${line}`)
  }
}

/** Starts the bundled Whisper.cpp streaming adapter for the chosen local model. */
export function configureTranscriber(language = 'pt-BR', requestedModel = '') {
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
  if (child && currentModelPath === modelPath) return true
  if (child) child.kill()

  currentModelPath = modelPath
  outputBuffer = ''
  console.log(`[Transcriber] Starting Whisper.cpp with ${modelFile}`)
  const spawnedChild = spawn(whisperBinary, [modelPath, languageCode(language)], {
    stdio: ['pipe', 'pipe', 'inherit']
  })
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
      currentModelPath = null
    }
  })
  return true
}

/** Feeds 16 kHz signed-16-bit PCM audio to Whisper.cpp. */
export function processAudioStream(data, onSentence) {
  sentenceCallback = onSentence
  if (!child && !configureTranscriber(currentLanguage)) return
  if (child?.stdin?.writable && !child.stdin.destroyed && !child.stdin.writableEnded)
    child.stdin.write(data)
}

/** Stops the local Whisper process and releases the model memory. */
export function stopTranscriber() {
  if (child) {
    child.kill()
    child = null
  }
  currentModelPath = null
  outputBuffer = ''
  sentenceCallback = null
}
