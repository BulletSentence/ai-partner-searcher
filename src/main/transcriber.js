import { spawn } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { logRuntimeEvent } from './runtimeLogger'

const childPath = join(process.cwd(), 'src/main/transcriberChild.js')
let child = null
let sentenceCallback = null
let currentModelDirectory = null

function isVoskModelDirectory(directory) {
  return (
    existsSync(join(directory, 'final.mdl')) ||
    existsSync(join(directory, 'am', 'final.mdl')) ||
    existsSync(join(directory, 'model.conf'))
  )
}

/** Lists valid Vosk model folders available beside the application. */
export function listTranscriptionModels() {
  try {
    return readdirSync(process.cwd(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('vosk-model'))
      .map((entry) => ({ id: entry.name, label: entry.name }))
      .filter((model) => isVoskModelDirectory(join(process.cwd(), model.id)))
  } catch (error) {
    console.error(`[Transcriber] Could not list models: ${error.message}`)
    logRuntimeEvent('transcriber_models_list_failed', { code: error.code, message: error.message })
    return []
  }
}

/**
 * Starts the speech recognizer for the requested language.
 * @param {string} language Supported values are pt-BR and en-US.
 */
export function configureTranscriber(language = 'pt-BR', requestedModel = '') {
  const falaBrasilDirectory = 'vosk-model-pt-fb-v0.1.1-20220516_2113'
  const modelDirectory = requestedModel || (language === 'en-US'
    ? 'vosk-model'
    : existsSync(join(process.cwd(), falaBrasilDirectory))
      ? falaBrasilDirectory
      : 'vosk-model-pt')

  if (language === 'pt-BR' && modelDirectory !== falaBrasilDirectory) {
    console.warn('[Transcriber] FalaBrasil model not found; using the small Portuguese model.')
  }

  const modelPath = join(process.cwd(), modelDirectory)
  if (!existsSync(modelPath)) {
    console.error(`[Transcriber] Model directory not found: ${modelPath}`)
    logRuntimeEvent('transcriber_model_missing', { language, modelDirectory, modelPath })
    child = null
    currentModelDirectory = null
    return false
  }

  if (child && currentModelDirectory === modelDirectory) {
    return
  }

  if (child) {
    child.kill()
  }

  currentModelDirectory = modelDirectory
  console.log(`[Transcriber] Spawning child process with ${modelDirectory}`)
  const spawnedChild = spawn('node', [childPath, modelDirectory], {
    stdio: ['pipe', 'inherit', 'inherit', 'ipc']
  })
  child = spawnedChild

  spawnedChild.on('message', (msg) => {
    if (msg && msg.text && typeof sentenceCallback === 'function') {
      sentenceCallback(msg.text)
    }
  })

  spawnedChild.on('error', (err) => {
    console.error(`[Transcriber] Child process error: ${err.message}`)
    logRuntimeEvent('transcriber_process_error', { code: err.code, message: err.message })
  })

  // The child can exit while an audio chunk is being delivered (for example
  // when the Vosk model is missing). Prevent the resulting EPIPE from
  // becoming an uncaught exception in the Electron main process.
  spawnedChild.stdin.on('error', (err) => {
    console.error(`[Transcriber] Input stream error: ${err.message}`)
    logRuntimeEvent('transcriber_input_error', { code: err.code, message: err.message })
  })

  spawnedChild.on('close', (code) => {
    console.warn(`[Transcriber] Child process closed with code ${code}`)
    if (code !== 0) {
      logRuntimeEvent('transcriber_process_closed', { code, modelDirectory })
    }
    if (child === spawnedChild) {
      child = null
      currentModelDirectory = null
    }
  })

  return true
}

/**
 * Feeds a chunk of PCM audio data into the child transcriber process.
 * @param {Buffer} data Raw PCM audio buffer.
 * @param {function(string)} onSentence Callback invoked when a complete sentence is recognized.
 */
export function processAudioStream(data, onSentence) {
  sentenceCallback = onSentence
  if (!child) {
    if (!configureTranscriber('pt-BR')) return
  }
  if (child?.stdin?.writable && !child.stdin.destroyed && !child.stdin.writableEnded) {
    try {
      child.stdin.write(data)
    } catch (err) {
      if (err.code !== 'EPIPE') {
        console.error(`[Transcriber] Could not send audio chunk: ${err.message}`)
      }
      logRuntimeEvent('transcriber_write_error', { code: err.code, message: err.message })
    }
  }
}
