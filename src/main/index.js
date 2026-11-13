import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  dialog,
  desktopCapturer,
  screen,
  session
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { listAudioOutputs, startAudioCapture } from './audioCapture'
import {
  CHANNEL_OTHERS,
  CHANNEL_ME,
  buildWhisperPrompt,
  configureTranscriber,
  getTranscriberPrompt,
  getTranscriberStatus,
  getVadModelPath,
  getWhisperBinary,
  resolveTranscriptionModel,
  listTranscriptionModels,
  processAudioStream,
  setTranscriptionHandlers,
  stopTranscriber
} from './transcriber'
import {
  configureAI,
  generateMeetingHelp,
  getConversationHistory,
  getDefaultMeetingProfile
} from './aiService'
import { captureScreenAndExtractText } from './screenCapture'
import { createMeetingRecorder, listSavedMeetings, speakerLabel } from './meetingRecorder'
import { isEchoOfOthers, isUsableTranscript } from './transcriptFilter'
import { transcribeRecording } from './finalTranscription'
import { readFile } from 'fs/promises'
import { exportFinalTranscript } from './harnessExport'
import { loadHarnessSearchConfig, searchHarness } from './harnessSearch'
import { findRelevantContext, indexKnowledgeSources } from './contextService'
import { isLikelyQuestion } from './questionDetector'
import { logRuntimeEvent } from './runtimeLogger'
import { getMeetingSettings, saveMeetingSettings } from './meetingSettings'
import {
  correctTerminology,
  getCanonicalTerminology,
  loadTerminologyFile
} from './terminologyService'

let mainWindow = null

const meetingsDirectory = process.env.MEETINGS_DIR || join(process.cwd(), 'meetings')
// A microphone utterance waits this long so a matching utterance from the call can expose it as speaker echo.
const MIC_ECHO_HOLD_MS = 2_500
const RECENT_UTTERANCES = 30
const CONTEXT_UTTERANCES = 6
const CONTEXT_MAX_CHARS = 900

// Rolling context variables
let recentUtterances = []
let pendingMicUtterances = []
let meetingRecorder = null
let stopPromise = null
let isQuitting = false
let finalTranscriptionJob = null
// Suggested answers cost tokens; the owner can switch the automatic ones off.
let autoAnswerEnabled = true

// Session state variables
let currentMeetingData = null
let harnessSearchConfig = null
let audioCaptureProcess = null
let answerRequestId = 0
let activeAnswerController = null
let lastMeetingQuestion = ''
let activeSourceFilter = 'all'
let meetingDiagnostics = []

function isMeetingFolder(folder) {
  return typeof folder === 'string' && folder.startsWith(meetingsDirectory)
}

/**
 * Transcribes a saved meeting again from its recording, in the background and without the
 * constraints of the live view, to produce the transcript kept as documentation.
 */
async function startFinalTranscription(folder) {
  finalTranscriptionJob?.controller.abort()
  const controller = new AbortController()
  finalTranscriptionJob = { folder, controller }
  const report = (state, extra = {}) =>
    sendToWindow('final-transcript-status', { folder, state, ...extra })

  try {
    let summary = null
    try {
      summary = JSON.parse(await readFile(join(folder, 'reuniao.json'), 'utf8'))
    } catch {
      // A meeting interrupted before its summary was written still has audio to transcribe.
    }
    const language = summary?.meeting?.language === 'en-US' ? 'en-US' : 'pt-BR'
    // With no hurry, the most accurate model available is worth its extra time.
    const modelFile = [
      process.env.WHISPER_FINAL_MODEL,
      'ggml-large-v3.bin',
      summary?.meeting?.transcriberModel,
      listTranscriptionModels()[0]?.id
    ].find((file) => resolveTranscriptionModel(file))
    const binary = getWhisperBinary()
    if (!binary || !modelFile) throw new Error('O Whisper não está configurado.')

    await loadTerminologyFile()
    const context = summary?.meeting?.context
    report('running', { progress: 0 })
    await transcribeRecording({
      folder,
      binary,
      modelPath: resolveTranscriptionModel(modelFile),
      vadModelPath: getVadModelPath(),
      modelLabel: modelFile.replace(/^ggml-/, '').replace(/\.(bin|gguf)$/i, ''),
      language,
      prompt: buildWhisperPrompt({
        meetingContext: context && context !== 'N/A' ? context : '',
        terms: getCanonicalTerminology(),
        language
      }),
      correctText: correctTerminology,
      signal: controller.signal,
      onProgress: (progress) => report('running', { progress })
    })
    console.log(`[Meeting] Final transcript written to: ${folder}`)
    report('done')
  } catch (error) {
    if (controller.signal.aborted) {
      report('cancelled')
    } else {
      console.error(`[Meeting] Final transcription failed: ${error.message}`)
      logRuntimeEvent('final_transcription_failed', { message: error.message })
      report('failed', { message: error.message })
    }
  } finally {
    if (finalTranscriptionJob?.controller === controller) finalTranscriptionJob = null
  }
}

/** The lines spoken just before a question, labelled by speaker, newest last. */
function describeRecentConversation(questionText) {
  const lines = recentUtterances
    .filter((entry) => entry.text !== questionText)
    .slice(-CONTEXT_UTTERANCES)
    .map((entry) => `${speakerLabel(entry.speaker)}: ${entry.text}`)
  let text = lines.join('\n')
  while (text.length > CONTEXT_MAX_CHARS && lines.length > 1) {
    lines.shift()
    text = lines.join('\n')
  }
  return text.slice(-CONTEXT_MAX_CHARS)
}

async function generateMeetingAnswer(questionText) {
  activeAnswerController?.abort()
  const controller = new AbortController()
  activeAnswerController = controller
  const requestId = ++answerRequestId
  lastMeetingQuestion = questionText
  const startedAt = Date.now()
  const recentConversation = describeRecentConversation(questionText)
  const localExcerpts = findRelevantContext(questionText, {
    source: activeSourceFilter,
    context: recentConversation
  })
  sendToWindow('on-ai-answer-start', {
    status: 'Buscando no Harness e na base local…',
    question: questionText
  })
  const config = harnessSearchConfig
  const remoteExcerpts =
    activeSourceFilter === 'all' ||
    activeSourceFilter === config?.vault ||
    activeSourceFilter === config?.selected
      ? await searchHarness(questionText, { config, signal: controller.signal })
      : []
  if (controller.signal.aborted || requestId !== answerRequestId) return
  const excerpts = [
    ...remoteExcerpts,
    ...localExcerpts.filter((local) => !remoteExcerpts.some((remote) => remote.path === local.path))
  ].slice(0, 4)
  logRuntimeEvent('answer_requested', {
    localExcerptCount: excerpts.length,
    sourceFilter: activeSourceFilter
  })
  const searchMs = Date.now() - startedAt
  let firstTokenMs = null
  const sources = excerpts.map((excerpt) => excerpt.path)

  generateMeetingHelp(
    questionText,
    excerpts,
    (answer, provider) => {
      if (requestId !== answerRequestId || controller.signal.aborted) return
      const totalMs = Date.now() - startedAt
      const latency = { searchMs, firstTokenMs: firstTokenMs ?? totalMs, totalMs }
      meetingDiagnostics.push({
        timestamp: new Date().toISOString(),
        question: questionText,
        answer,
        provider,
        sources,
        latency
      })
      logRuntimeEvent('answer_completed', {
        provider,
        totalMs,
        firstTokenMs: latency.firstTokenMs,
        sourceCount: sources.length
      })
      console.log(`[AI Answer] [${provider}] using ${excerpts.length} local excerpt(s): ${answer}`)
      if (mainWindow) {
        mainWindow.webContents.send('on-ai-answer', {
          question: questionText,
          answer,
          provider,
          sources,
          latency
        })
      }
    },
    (delta, provider) => {
      if (requestId !== answerRequestId || controller.signal.aborted) return
      if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt
      if (mainWindow) {
        mainWindow.webContents.send('on-ai-answer-delta', {
          delta,
          provider,
          sources,
          latency: { searchMs, firstTokenMs },
          status: 'Respondendo…'
        })
      }
    },
    controller.signal,
    (status) => {
      if (requestId !== answerRequestId || controller.signal.aborted || !mainWindow) return
      mainWindow.webContents.send('on-ai-answer-status', status)
      logRuntimeEvent('provider_status', { status })
    },
    recentConversation
  )
}

// When true the window is hidden from screen sharing / screenshots.
const CONTENT_PROTECTION = true

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    // Short enough that the answers panel shows only the current answer (below 540 px);
    // making the window taller reveals the previous one or two.
    height: 520,
    // Below this the forms stop fitting; the layout adapts to anything larger.
    minWidth: 420,
    minHeight: 360,
    show: false,
    autoHideMenuBar: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.setContentProtection(CONTENT_PROTECTION)

  if (process.platform === 'darwin') {
    session.defaultSession.setDisplayMediaRequestHandler(
      async (_request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false
          })
          callback(sources[0] ? { video: sources[0], audio: 'loopback' } : null)
        } catch (error) {
          logRuntimeEvent('native_audio_capture_setup_failed', {
            platform: process.platform,
            message: error.message
          })
          callback(null)
        }
      },
      { useSystemPicker: false }
    )
  }

  // OCR screen grab hotkey (Ctrl+Shift+S)
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    console.log('[OCR] Screen Capture and OCR starting...')
    const startTime = Date.now()

    const extractedText = await captureScreenAndExtractText()

    const latency = Date.now() - startTime
    console.log(`[OCR] Screen Capture and OCR completed in ${latency}ms`)

    if (extractedText) {
      console.log(`[OCR Context] Detected text (length: ${extractedText.length})`)

      generateMeetingAnswer(correctTerminology(extractedText))
    } else {
      console.log('[OCR] No text extracted from primary screen.')
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (mainWindow) mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

let currentAudioSource = 'system'
let currentAudioOutputDevice = ''
let lastAudioLevelSentTime = 0

function calculateAndSendAudioLevel(chunk) {
  const now = Date.now()
  if (now - lastAudioLevelSentTime < 100) {
    return
  }

  if (!chunk || chunk.length < 2) {
    return
  }

  let sum = 0
  let sampleCount = 0
  for (let i = 0; i < chunk.length - 1; i += 2) {
    const sample = chunk.readInt16LE(i)
    sum += sample * sample
    sampleCount++
  }

  if (sampleCount === 0) return

  const rms = Math.sqrt(sum / sampleCount)
  const referenceMaxRms = 8000
  const rawLevel = (rms / referenceMaxRms) * 100
  const level = Math.min(100, Math.max(0, Math.floor(rawLevel)))

  lastAudioLevelSentTime = now
  if (mainWindow) {
    mainWindow.webContents.send('audio-level', level)
  }
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function meetingElapsedMs() {
  return meetingRecorder ? Date.now() - meetingRecorder.startedAt.getTime() : 0
}

/** Saves an utterance, shows it, and asks the AI when another participant asked something. */
function commitUtterance(entry) {
  meetingRecorder?.addUtterance(entry)
  recentUtterances.push(entry)
  if (recentUtterances.length > RECENT_UTTERANCES) recentUtterances.shift()
  console.log(`[Transcription] [${entry.speaker}]: ${entry.text}`)
  sendToWindow('on-transcription', {
    speaker: entry.speaker,
    label: speakerLabel(entry.speaker),
    text: entry.text
  })

  // Only questions from the other participants are answered automatically, and only while
  // suggested answers are switched on. The owner's own speech is answered
  // only while "Perguntar" is active, when everything said to the microphone is a request.
  const isOwnerRequest =
    entry.speaker === 'me' && currentAudioSource === 'mic' && entry.text.length >= 8
  if (
    !stopPromise &&
    (isOwnerRequest ||
      (autoAnswerEnabled && entry.speaker === 'others' && isLikelyQuestion(entry.text)))
  ) {
    generateMeetingAnswer(entry.text)
  }
}

function commitMicUtterance(entry) {
  const otherUtterances = recentUtterances.filter((item) => item.speaker === 'others')
  if (isEchoOfOthers(entry, otherUtterances)) {
    console.log(`[Transcription] Dropped microphone echo of the call: ${entry.text}`)
    return
  }
  commitUtterance(entry)
}

function flushPendingMicUtterances() {
  const pending = pendingMicUtterances
  pendingMicUtterances = []
  for (const { entry, timer } of pending) {
    clearTimeout(timer)
    commitMicUtterance(entry)
  }
}

function handleFinalUtterance(utterance) {
  const speaker = utterance.channel === CHANNEL_ME ? 'me' : 'others'
  sendToWindow('on-transcription-partial', { speaker, label: speakerLabel(speaker), text: '' })
  const text = correctTerminology(utterance.text)
  const usable = isUsableTranscript(text, {
    noSpeechProbability: utterance.noSpeechProbability,
    confidence: utterance.confidence,
    durationMs: utterance.endMs - utterance.startMs,
    prompt: getTranscriberPrompt()
  })
  if (!usable || !meetingRecorder) return

  const offset = meetingRecorder.trackOffsetMs(speaker)
  const entry = {
    speaker,
    text,
    startMs: offset + utterance.startMs,
    endMs: offset + utterance.endMs
  }
  if (speaker === 'me' && currentAudioSource !== 'mic') {
    const pending = { entry, timer: null }
    pending.timer = setTimeout(() => {
      pendingMicUtterances = pendingMicUtterances.filter((item) => item !== pending)
      commitMicUtterance(entry)
    }, MIC_ECHO_HOLD_MS)
    pendingMicUtterances.push(pending)
  } else {
    commitUtterance(entry)
  }
}

function handlePartialUtterance(utterance) {
  const speaker = utterance.channel === CHANNEL_ME ? 'me' : 'others'
  sendToWindow('on-transcription-partial', {
    speaker,
    label: speakerLabel(speaker),
    text: correctTerminology(utterance.text)
  })
}

/**
 * Receives 16 kHz mono PCM from one side of the meeting: records it and sends it to Whisper.
 * Without an explicit channel the audio belongs to whichever single source is being captured.
 */
function handleCapturedAudio(chunk, channel) {
  if (!currentMeetingData || stopPromise) return
  const legacyChannel = currentAudioSource === 'mic' ? CHANNEL_ME : CHANNEL_OTHERS
  const audioChannel =
    channel === CHANNEL_ME || channel === CHANNEL_OTHERS ? channel : legacyChannel
  if (audioChannel === legacyChannel) calculateAndSendAudioLevel(chunk)
  meetingRecorder?.writeAudio(audioChannel === CHANNEL_ME ? 'me' : 'others', chunk)
  processAudioStream(chunk, audioChannel)
}

function switchAudioSource(source) {
  currentAudioSource = source === 'mic' ? 'mic' : 'system'
  console.log(`[Main] Switched active audio source variable to: ${currentAudioSource}`)

  // macOS captures system audio and microphone together in the renderer for the whole meeting;
  // switching only changes whether the owner's speech is treated as a request to the copilot.
  if (process.platform === 'darwin') {
    sendToWindow('start-native-audio-capture')
    return
  }

  if (audioCaptureProcess) {
    try {
      audioCaptureProcess.kill()
    } catch (e) {
      console.error('[Main] Error killing audio process on switch:', e.message)
    }
    audioCaptureProcess = null
  }

  if (currentMeetingData) {
    audioCaptureProcess = startAudioCapture(
      (chunk) => handleCapturedAudio(chunk),
      currentAudioSource,
      currentAudioOutputDevice
    )
  }
}

async function finishMeetingSession() {
  activeAnswerController?.abort()
  activeAnswerController = null
  if (audioCaptureProcess) {
    try {
      audioCaptureProcess.kill()
    } catch (e) {
      console.error('[Main] Error stopping audio capture:', e.message)
    }
    audioCaptureProcess = null
  }
  if (process.platform === 'darwin') sendToWindow('stop-native-audio-capture')

  // Whisper finishes the sentence that was being spoken before the transcript is written.
  await stopTranscriber()
  flushPendingMicUtterances()

  const recorder = meetingRecorder
  try {
    if (recorder) {
      const folder = await recorder.finalize({
        conversationHistory: getConversationHistory(),
        diagnostics: meetingDiagnostics
      })
      console.log(`[Meeting] Saved audio and transcript to: ${folder}`)
      sendToWindow('meeting-saved', folder)
      // The careful second pass runs on its own; the meeting is already safely on disk.
      if (!isQuitting) startFinalTranscription(folder)
    }
  } catch (error) {
    console.error(`[Meeting] Could not finish saving the meeting: ${error.message}`)
    logRuntimeEvent('meeting_save_failed', { message: error.message })
  } finally {
    meetingRecorder = null
    currentMeetingData = null
    recentUtterances = []
  }
}

/**
 * Halts active capture sessions and saves the recording and transcript.
 * Safe to call repeatedly: concurrent calls share the same shutdown.
 */
function handleStopSession() {
  if (stopPromise) return stopPromise
  if (!currentMeetingData) return Promise.resolve()
  stopPromise = finishMeetingSession().finally(() => {
    stopPromise = null
  })
  return stopPromise
}

// IPC: Minimize Window
ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize()
})

// IPC: Close Window
ipcMain.on('close-window', () => {
  app.quit()
})

let expandedWindowWidth = 900
let transcriptWindowCollapsed = false

// During a meeting the window can follow the length of the answers: the renderer reports the
// height its content needs and the window grows or shrinks downwards, never past the screen.
const AUTO_HEIGHT_MIN = 360
ipcMain.on('fit-window-height', (_event, height) => {
  if (!mainWindow || mainWindow.isDestroyed() || !currentMeetingData) return
  if (mainWindow.isMaximized() || mainWindow.isFullScreen() || !Number.isFinite(height)) return
  const bounds = mainWindow.getBounds()
  const workArea = screen.getDisplayMatching(bounds).workArea
  const available = workArea.y + workArea.height - bounds.y
  const [, minimumHeight] = mainWindow.getMinimumSize()
  const target = Math.round(Math.min(Math.max(height, minimumHeight, AUTO_HEIGHT_MIN), available))
  if (Math.abs(target - bounds.height) < 4) return
  mainWindow.setBounds({ ...bounds, height: target })
})

ipcMain.on('set-transcript-collapsed', (_event, collapsed) => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    typeof collapsed !== 'boolean' ||
    collapsed === transcriptWindowCollapsed
  )
    return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  const [width, height] = mainWindow.getSize()
  if (collapsed) {
    expandedWindowWidth = width
    mainWindow.setSize(Math.min(width, 560), height)
  } else {
    mainWindow.setSize(Math.max(expandedWindowWidth, width), height)
  }
  transcriptWindowCollapsed = collapsed
})

// IPC: Stop meeting manually.
ipcMain.on('stop-meeting', () => {
  console.log('[Main] Stopping meeting session manually.')
  handleStopSession()
  if (mainWindow && transcriptWindowCollapsed) {
    const [, height] = mainWindow.getSize()
    mainWindow.setSize(expandedWindowWidth, height)
    transcriptWindowCollapsed = false
  }

  // Unlock mouse events and notify renderer
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(false)
    mainWindow.webContents.send('window-unlocked', true)
  }
})

// IPC: Start meeting.
ipcMain.on('start-meeting', async (_event, data) => {
  // A previous meeting may still be writing its files.
  await handleStopSession()
  // The live transcription needs the machine; an unfinished final pass can be redone from the history.
  finalTranscriptionJob?.controller.abort()

  // Load the matching local speech recognition model before audio capture begins.
  const meetingProfile = configureAI(data)
  harnessSearchConfig = await loadHarnessSearchConfig(data)
  const grammar = await loadTerminologyFile()
  if (grammar.error) {
    console.warn(`[Terminology] Could not load ${grammar.path}: ${grammar.error}`)
  } else {
    console.log(`[Terminology] Loaded ${grammar.count} grammar term(s) from ${grammar.path}`)
  }
  currentAudioOutputDevice =
    typeof data?.audioOutputDevice === 'string' ? data.audioOutputDevice : ''
  recentUtterances = []
  pendingMicUtterances = []
  meetingDiagnostics = []
  autoAnswerEnabled = data?.autoAnswer !== false

  try {
    meetingRecorder = createMeetingRecorder({
      baseDir: meetingsDirectory,
      meeting: { ...meetingProfile, transcriberModel: data?.transcriberModel || '' }
    })
    console.log(`[Meeting] Recording to: ${meetingRecorder.dir}`)
  } catch (error) {
    meetingRecorder = null
    console.error(`[Meeting] Recording is disabled: ${error.message}`)
    logRuntimeEvent('meeting_recorder_failed', { message: error.message })
  }
  currentMeetingData = meetingProfile

  // The vocabulary prompt makes Whisper expect the meeting's own names and acronyms.
  setTranscriptionHandlers({ onFinal: handleFinalUtterance, onPartial: handlePartialUtterance })
  configureTranscriber(meetingProfile.language, data?.transcriberModel, {
    prompt: buildWhisperPrompt({
      meetingContext: meetingProfile.meetingContext,
      terms: getCanonicalTerminology(),
      language: meetingProfile.language
    })
  })

  // Start audio capture in system monitor mode initially
  switchAudioSource('system')

  // Lock click-through on start
  if (mainWindow) {
    // Keep the HUD click-through by default; hovering the top bar enables controls.
    mainWindow.setIgnoreMouseEvents(true, { forwardToDesktop: true })
    mainWindow.webContents.send('window-unlocked', false)
  }
})

// The renderer explicitly prepares local sources before capture begins, so startup
// can report an actionable status without delaying audio capture unexpectedly.
ipcMain.handle('prepare-knowledge-sources', async (_event, data) => {
  activeSourceFilter = 'all'
  return indexKnowledgeSources(data)
})

ipcMain.handle('get-audio-outputs', () => listAudioOutputs())
ipcMain.handle('get-transcription-models', () => listTranscriptionModels())
ipcMain.handle('get-transcriber-status', () => getTranscriberStatus())

ipcMain.on('native-audio-chunk', (_event, chunk, channel) => {
  if (process.platform === 'darwin' && currentMeetingData) {
    handleCapturedAudio(Buffer.from(chunk), channel === CHANNEL_ME ? CHANNEL_ME : CHANNEL_OTHERS)
  }
})

ipcMain.on('native-audio-capture-error', (_event, message) => {
  logRuntimeEvent('native_audio_capture_error', { platform: process.platform, message })
  console.error(`[Native Audio] ${message}`)
})

// Native folder pickers used by the initial setup form.
ipcMain.handle('select-folders', async (_event, { multiple = false } = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: multiple ? 'Selecione até 2 pastas de projeto' : 'Selecione a pasta do Obsidian',
    properties: ['openDirectory', ...(multiple ? ['multiSelections'] : [])]
  })

  return {
    canceled: result.canceled,
    // The setup supports no project folder or at most two project folders.
    filePaths: multiple ? result.filePaths.slice(0, 2) : result.filePaths.slice(0, 1)
  }
})

// IPC: Toggle Audio Source
ipcMain.on('toggle-audio-source', (_event, source) => {
  switchAudioSource(source)
})

ipcMain.on('ask-meeting-question', (_event, question) => {
  const text = typeof question === 'string' ? question.trim() : ''
  if (!text || !currentMeetingData) return
  const elapsedMs = meetingElapsedMs()
  meetingRecorder?.addUtterance({ speaker: 'manual', text, startMs: elapsedMs, endMs: elapsedMs })
  sendToWindow('on-transcription', { speaker: 'manual', label: speakerLabel('manual'), text })
  generateMeetingAnswer(text)
})

ipcMain.on('set-auto-answer', (_event, enabled) => {
  autoAnswerEnabled = enabled !== false
  // Switching off also stops an answer that is being generated.
  if (!autoAnswerEnabled) activeAnswerController?.abort()
})

ipcMain.on('retry-last-meeting-question', () => {
  if (lastMeetingQuestion && currentMeetingData) generateMeetingAnswer(lastMeetingQuestion)
})

ipcMain.on('set-knowledge-source-filter', (_event, source) => {
  activeSourceFilter = typeof source === 'string' && source ? source : 'all'
})

// IPC: Interactive and Clickthrough Window Hover controls
ipcMain.on('set-window-interactive', () => {
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(false)
    mainWindow.webContents.send('window-unlocked', true)
  }
})

ipcMain.on('set-window-clickthrough', () => {
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(true, { forwardToDesktop: true })
    mainWindow.webContents.send('window-unlocked', false)
  }
})

// IPC: Standard Window Maximize
ipcMain.on('maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
})

// IPC Handler: read and return saved meeting sessions.
ipcMain.handle('get-saved-meetings', async () => {
  try {
    return await listSavedMeetings(meetingsDirectory)
  } catch (err) {
    console.error('[Main] get-saved-meetings failed:', err.message)
    return []
  }
})

ipcMain.on('open-meeting-folder', (_event, folder) => {
  // Only folders inside the meetings directory may be opened from the renderer.
  if (isMeetingFolder(folder)) shell.openPath(folder)
})

ipcMain.handle('export-final-transcript', async (_event, { folder, destination }) => {
  try {
    const path = await exportFinalTranscript({ meetingsDirectory, folder, destination })
    return { path }
  } catch (error) {
    return { error: error.message }
  }
})

ipcMain.on('generate-final-transcript', (_event, folder) => {
  if (isMeetingFolder(folder) && !currentMeetingData) startFinalTranscription(folder)
})

// Persistent profile values are intentionally exposed without API keys.
ipcMain.handle('get-content-protection', () =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow.isContentProtected() : CONTENT_PROTECTION
)
ipcMain.handle('get-default-meeting-profile', () => getDefaultMeetingProfile())
ipcMain.handle('get-meeting-settings', () => getMeetingSettings())
ipcMain.handle('save-meeting-settings', async (_event, settings) => {
  await saveMeetingSettings(settings)
  return true
})

// App Lifecycle
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  handleStopSession()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Quitting waits for the recording and transcript of the current meeting to be written.
app.on('before-quit', (event) => {
  if (isQuitting || (!currentMeetingData && !stopPromise)) return
  event.preventDefault()
  isQuitting = true
  handleStopSession().finally(() => app.quit())
})

app.on('will-quit', () => {
  finalTranscriptionJob?.controller.abort()
  globalShortcut.unregisterAll()
})
