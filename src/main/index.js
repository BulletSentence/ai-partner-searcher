import { app, shell, BrowserWindow, ipcMain, globalShortcut } from 'electron'
import { join } from 'path'
import fs from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startAudioCapture } from './audioCapture'
import { configureTranscriber, processAudioStream } from './transcriber'
import {
  configureAI,
  generateMeetingHelp,
  getConversationHistory,
  getDefaultMeetingProfile
} from './aiService'
import { captureScreenAndExtractText } from './screenCapture'
import { saveMeetingSession } from './meetingSessionLogger'
import { findRelevantContext, indexKnowledgeSources } from './contextService'
import { isLikelyQuestion } from './questionDetector'
import { logRuntimeEvent } from './runtimeLogger'
import { getMeetingSettings, saveMeetingSettings } from './meetingSettings'
import { correctTerminology, loadTerminologyFile } from './terminologyService'

let mainWindow = null

// Rolling context variables
let transcriptSentences = []
let aiTimeout = null

// Session state variables
let currentMeetingData = null
let audioCaptureProcess = null
let answerRequestId = 0
let activeAnswerController = null
let lastMeetingQuestion = ''
let activeSourceFilter = 'all'
let meetingDiagnostics = []

function generateMeetingAnswer(questionText) {
  activeAnswerController?.abort()
  const controller = new AbortController()
  activeAnswerController = controller
  const requestId = ++answerRequestId
  lastMeetingQuestion = questionText
  const startedAt = Date.now()
  const excerpts = findRelevantContext(questionText, { source: activeSourceFilter })
  logRuntimeEvent('answer_requested', {
    localExcerptCount: excerpts.length,
    sourceFilter: activeSourceFilter
  })
  const searchMs = Date.now() - startedAt
  let firstTokenMs = null
  const sources = excerpts.map((excerpt) => excerpt.path)

  if (mainWindow) {
    mainWindow.webContents.send('on-ai-answer-start', { status: 'Buscando na base local…' })
  }

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
    }
  )
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
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

  mainWindow.setContentProtection(true)

  // OCR screen grab hotkey (Ctrl+Shift+S)
  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    console.log('[OCR] Screen Capture and OCR starting...')
    const startTime = Date.now()

    const extractedText = await captureScreenAndExtractText()

    const latency = Date.now() - startTime
    console.log(`[OCR] Screen Capture and OCR completed in ${latency}ms`)

    if (extractedText) {
      console.log(`[OCR Context] Detected text (length: ${extractedText.length})`)

      const normalizedText = correctTerminology(extractedText)
      const prefix = `[Screen Context Detected]: ${normalizedText}`
      transcriptSentences.push(prefix)

      if (aiTimeout) {
        clearTimeout(aiTimeout)
      }

      generateMeetingAnswer(normalizedText)
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

function switchAudioSource(source) {
  currentAudioSource = source
  console.log(`[Main] Switched active audio source variable to: ${source}`)

  if (audioCaptureProcess) {
    try {
      audioCaptureProcess.kill()
    } catch (e) {
      console.error('[Main] Error killing audio process on switch:', e.message)
    }
    audioCaptureProcess = null
  }

  if (currentMeetingData) {
    audioCaptureProcess = startAudioCapture((chunk) => {
      calculateAndSendAudioLevel(chunk)

      processAudioStream(chunk, (text) => {
        const normalizedText = correctTerminology(text)
        console.log(`[Transcription] [${currentAudioSource}]: ${normalizedText}`)
        if (mainWindow) {
          mainWindow.webContents.send('on-transcription', normalizedText)
        }

        let formattedText = normalizedText
        if (currentAudioSource === 'mic') {
          formattedText = `[Question asked in the meeting]: ${normalizedText}`
        }

        transcriptSentences.push(formattedText)
        if (aiTimeout) {
          clearTimeout(aiTimeout)
        }

        if (isLikelyQuestion(normalizedText)) {
          aiTimeout = setTimeout(() => {
            generateMeetingAnswer(normalizedText)
          }, 650)
        }
      })
    }, source)
  }
}

/**
 * Halts active capture sessions and saves transcript records.
 */
function handleStopSession() {
  activeAnswerController?.abort()
  activeAnswerController = null
  if (aiTimeout) {
    clearTimeout(aiTimeout)
    aiTimeout = null
  }
  if (audioCaptureProcess) {
    try {
      audioCaptureProcess.kill()
    } catch (e) {
      console.error('[Main] Error stopping parec capture:', e.message)
    }
    audioCaptureProcess = null
  }

  if (currentMeetingData) {
    const history = getConversationHistory()
    if (history.length > 0) {
      saveMeetingSession(currentMeetingData, history, meetingDiagnostics)
    }
    currentMeetingData = null
  }
}

// IPC: Minimize Window
ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize()
})

// IPC: Close Window
ipcMain.on('close-window', () => {
  app.quit()
})

// IPC: Stop meeting manually.
ipcMain.on('stop-meeting', () => {
  console.log('[Main] Stopping meeting session manually.')
  handleStopSession()

  // Unlock mouse events and notify renderer
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(false)
    mainWindow.webContents.send('window-unlocked', true)
  }
})

// IPC: Start meeting.
ipcMain.on('start-meeting', async (_event, data) => {
  // Load the matching local speech recognition model before audio capture begins.
  const meetingProfile = configureAI(data)
  const grammar = await loadTerminologyFile()
  if (grammar.error) {
    console.warn(`[Terminology] Could not load ${grammar.path}: ${grammar.error}`)
  } else {
    console.log(`[Terminology] Loaded ${grammar.count} grammar term(s) from ${grammar.path}`)
  }
  currentMeetingData = meetingProfile
  configureTranscriber(meetingProfile.language)

  // Configure AI prompt instructions

  // Reset transcript array
  transcriptSentences = []
  meetingDiagnostics = []
  if (aiTimeout) {
    clearTimeout(aiTimeout)
    aiTimeout = null
  }

  // Start audio capture in system monitor mode initially
  switchAudioSource('system')

  // Lock click-through on start
  if (mainWindow) {
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

// IPC: Toggle Audio Source
ipcMain.on('toggle-audio-source', (_event, source) => {
  switchAudioSource(source)
})

ipcMain.on('ask-meeting-question', (_event, question) => {
  const text = typeof question === 'string' ? question.trim() : ''
  if (!text || !currentMeetingData) return
  const entry = `[Pergunta manual]: ${text}`
  transcriptSentences.push(entry)
  if (mainWindow) mainWindow.webContents.send('on-transcription', entry)
  generateMeetingAnswer(text)
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
  }
})

ipcMain.on('set-window-clickthrough', () => {
  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(true, { forwardToDesktop: true })
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
    const dir = join(process.cwd(), 'meetings')
    await fs.mkdir(dir, { recursive: true })
    const files = await fs.readdir(dir)
    const sessions = []
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = join(dir, file)
        const content = await fs.readFile(filePath, 'utf-8')
        sessions.push({
          filename: file,
          data: JSON.parse(content)
        })
      }
    }
    // Sort descending by filename timestamp
    sessions.sort((a, b) => b.filename.localeCompare(a.filename))
    return sessions
  } catch (err) {
    console.error('[Main] get-saved-meetings failed:', err.message)
    return []
  }
})

// Persistent profile values are intentionally exposed without API keys.
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

app.on('will-quit', () => {
  handleStopSession()
  globalShortcut.unregisterAll()
})
