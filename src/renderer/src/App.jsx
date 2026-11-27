import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function withoutDeleted(sessions, deleted) {
  return (Array.isArray(sessions) ? sessions : []).filter(
    (session) => !deleted.has(session.filename)
  )
}

// Shown on a saved meeting once its final transcript has been sent to the Harness.
function harnessBadge(session) {
  const exports = session.data.harnessExports
  if (!Array.isArray(exports) || !exports.length) return null
  const last = exports[exports.length - 1]
  const when = new Date(last.exportedAt).toLocaleString('pt-BR')
  return (
    <span
      className="harness-badge"
      title={`Enviada ao Harness em ${when}\n${last.path}${exports.length > 1 ? `\n(${exports.length} envios)` : ''}`}
    >
      Enviada ao Harness
    </span>
  )
}

function renderContentProtectionBadge(isProtected) {
  if (isProtected === null) return null
  return (
    <span
      className="content-protection-badge"
      aria-label={
        isProtected ? 'Oculto no compartilhamento de tela' : 'Visível no compartilhamento de tela'
      }
      title={
        isProtected
          ? 'setContentProtection ativo: a janela fica oculta em compartilhamento de tela e capturas'
          : 'setContentProtection desligado: a janela aparece em compartilhamento de tela e capturas'
      }
      style={{
        flex: '0 0 auto',
        padding: '1px 6px',
        borderRadius: '999px',
        border: `1px solid ${isProtected ? 'rgba(134, 239, 172, 0.35)' : 'rgba(251, 191, 36, 0.4)'}`,
        color: isProtected ? '#86efac' : '#fbbf24',
        fontSize: '0.62rem',
        fontWeight: 600,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        cursor: 'default'
      }}
    >
      {isProtected ? 'Privado' : 'Visível'}
    </span>
  )
}

function App() {
  const [isSetupComplete, setIsSetupComplete] = useState(false)

  // Form State
  const [formData, setFormData] = useState({
    meetingContext: '',
    // Glossary lines: `Nome certo: variação 1, variação 2`.
    terminology: '',
    harnessPath: '',
    projectPaths: '',
    obsidianVaultPath: '',
    audioOutputDevice: '',
    transcriberModel: '',
    language: 'pt-BR',
    autoAnswer: true,
    showLivePreview: false,
    transcriptCollapsed: true,
    // How many answers the panel shows (current, plus up to two earlier ones).
    answerCount: 1,
    // Window height follows the length of the answers during the meeting.
    autoHeight: true,
    // The manual question field in the answers panel.
    showManualQuestion: true,
    // Appearance: dark or light palette, and how opaque the window background is (30–100).
    theme: 'dark',
    backgroundOpacity: 62
  })

  // History Log States
  const [exportStatus, setExportStatus] = useState({})
  const [exportNotice, setExportNotice] = useState(null)
  const [savedSessions, setSavedSessions] = useState([])
  const [selectedSession, setSelectedSession] = useState(null)
  const [indexStatus, setIndexStatus] = useState(null)
  const [isContentProtected, setIsContentProtected] = useState(null)
  const [isPreparingSources, setIsPreparingSources] = useState(false)
  const [audioOutputs, setAudioOutputs] = useState([])
  const [transcriptionModels, setTranscriptionModels] = useState([])
  const [transcriberStatus, setTranscriberStatus] = useState({ binaryFound: false, modelsFound: 0 })

  // HUD State
  const [transcription, setTranscription] = useState(null)
  const [transcriptionHistory, setTranscriptionHistory] = useState([])
  const [savedMeetingFolder, setSavedMeetingFolder] = useState('')
  const [finalTranscriptStatus, setFinalTranscriptStatus] = useState(null)
  const [aiAnswer, setAiAnswer] = useState('')
  const [aiProvider, setAiProvider] = useState('')
  const [aiSources, setAiSources] = useState([])
  const [aiLatency, setAiLatency] = useState(null)
  const [isAnswerStreaming, setIsAnswerStreaming] = useState(false)
  // Besides the current answer the panel keeps the two before it, newest first. How many are
  // visible depends on the window height (see .previous-answer in main.css): 1, 2 or 3 in total.
  const [currentQuestion, setCurrentQuestion] = useState('')
  const [previousAnswers, setPreviousAnswers] = useState([])
  const completedAnswerRef = useRef(null)
  const answerAreaRef = useRef(null)
  const answerContentRef = useRef(null)
  const [answerStatus, setAnswerStatus] = useState('Ouvindo')
  const [manualQuestion, setManualQuestion] = useState('')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [hasLoadedSettings, setHasLoadedSettings] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [audioSource, setAudioSource] = useState('SYSTEM')
  const [isClickThrough, setIsClickThrough] = useState(true)
  const transcriptEndRef = useRef(null)
  const nativeAudioCleanupRef = useRef(null)

  const stopNativeAudioCapture = async () => {
    const cleanup = nativeAudioCleanupRef.current
    nativeAudioCleanupRef.current = null
    if (cleanup) await cleanup()
  }

  // Streams one audio track to the main process as 16 kHz mono PCM, tagged with who it belongs to.
  const streamTrackToMain = async (stream, channel) => {
    const audioContext = new AudioContext({ sampleRate: 16000 })
    const source = audioContext.createMediaStreamSource(stream)
    const silentGain = audioContext.createGain()
    silentGain.gain.value = 0
    let node

    try {
      // Preferred path: capture on the audio thread, in 100 ms blocks.
      await audioContext.audioWorklet.addModule(
        new URL('pcm-capture-worklet.js', document.baseURI).href
      )
      node = new AudioWorkletNode(audioContext, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'max'
      })
      node.port.onmessage = (event) => window.api.sendNativeAudioChunk(event.data, channel)
    } catch (error) {
      // Fallback: the older main-thread processor, which can drop audio when the window is busy.
      console.warn('AudioWorklet unavailable, using ScriptProcessor:', error)
      node = audioContext.createScriptProcessor(4096, 1, 1)
      node.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        const pcm = new Int16Array(input.length)
        for (let index = 0; index < input.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, input[index]))
          pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
        }
        window.api.sendNativeAudioChunk(pcm.buffer, channel)
      }
    }

    source.connect(node)
    node.connect(silentGain)
    silentGain.connect(audioContext.destination)

    return async () => {
      if (node.port) node.port.onmessage = null
      node.disconnect()
      source.disconnect()
      silentGain.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      await audioContext.close()
    }
  }

  // macOS: the system audio (the client, channel 0) and the microphone (you, channel 1) are
  // captured together for the whole meeting, so both sides are recorded and transcribed.
  const startNativeAudioCapture = async () => {
    if (!window.api.isMac || nativeAudioCleanupRef.current) return
    const cleanups = []
    nativeAudioCleanupRef.current = async () => {
      await Promise.all(cleanups.map((cleanup) => cleanup()))
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1, width: 1, height: 1 },
        audio: true
      })
      const audioTrack = stream.getAudioTracks()[0]
      if (!audioTrack) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error('O macOS não retornou uma faixa de áudio do sistema.')
      }
      const stopSystem = await streamTrackToMain(new MediaStream([audioTrack]), 0)
      cleanups.push(async () => {
        await stopSystem()
        stream.getTracks().forEach((track) => track.stop())
      })
    } catch (error) {
      nativeAudioCleanupRef.current = null
      window.api.reportNativeAudioError(error.message)
      throw error
    }

    // The meeting still works without the microphone: only your own side is left out.
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        // Automatic gain is off: it amplifies room noise during pauses, which blurs where speech ends.
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1
        },
        video: false
      })
      cleanups.push(await streamTrackToMain(micStream, 1))
    } catch (error) {
      window.api.reportNativeAudioError(`Microfone indisponível: ${error.message}`)
    }
  }

  // Describes the final-transcription job when it concerns the given meeting folder.
  const finalTranscriptLabel = (folder) => {
    if (!finalTranscriptStatus || finalTranscriptStatus.folder !== folder)
      return { running: false, text: '' }
    const { state, progress = 0, message } = finalTranscriptStatus
    if (state === 'running') {
      return { running: true, text: `Gerando transcrição final… ${Math.round(progress * 100)}%` }
    }
    if (state === 'failed') return { running: false, text: `Não foi possível gerar: ${message}` }
    if (state === 'cancelled') return { running: false, text: 'Transcrição final interrompida.' }
    return { running: false, text: '' }
  }

  // Meetings deleted in this window. A listing taken while the Trash move is still finishing
  // would otherwise bring them back.
  const deletedMeetingsRef = useRef(new Set())

  // Load saved sessions when returning to the setup screen
  const loadSavedSessions = async () => {
    try {
      const sessions = await window.api.getSavedMeetings()
      setSavedSessions(withoutDeleted(sessions, deletedMeetingsRef.current))
    } catch (err) {
      console.error('Error loading saved sessions:', err)
    }
  }

  useEffect(() => {
    window.api
      .getContentProtection()
      .then(setIsContentProtected)
      .catch(() => setIsContentProtected(null))
  }, [])

  const toggleContentProtection = () => {
    window.api
      .setContentProtection(!isContentProtected)
      .then(setIsContentProtected)
      .catch((err) => console.error('Error changing privacy mode:', err))
  }

  useEffect(() => {
    if (!isSetupComplete) {
      const timeoutId = setTimeout(loadSavedSessions, 0)
      return () => clearTimeout(timeoutId)
    }
  }, [isSetupComplete])

  // Saved setup values take precedence over defaults supplied through .env.
  useEffect(() => {
    Promise.all([window.api.getDefaultMeetingProfile(), window.api.getMeetingSettings()])
      .then(([profile, settings]) =>
        setFormData((current) => ({
          ...current,
          ...profile,
          ...settings,
          showLivePreview: false,
          transcriptCollapsed: true
        }))
      )
      .catch((err) => console.error('Error loading meeting settings:', err))
      .finally(() => setHasLoadedSettings(true))
  }, [])

  useEffect(() => {
    window.api.onWindowLockChange((isInteractive) => setIsClickThrough(!isInteractive))
    window.api.onNativeAudioCaptureStart(() => {
      startNativeAudioCapture().catch((err) => console.error('Native audio capture failed:', err))
    })
    window.api.onNativeAudioCaptureStop(() => {
      stopNativeAudioCapture().catch((err) => console.error('Native audio cleanup failed:', err))
    })
  }, [])

  useEffect(() => {
    Promise.all([window.api.getTranscriptionModels(), window.api.getTranscriberStatus()])
      .then(([models, status]) => {
        const availableModels = Array.isArray(models) ? models : []
        setTranscriptionModels(availableModels)
        setTranscriberStatus(status || { binaryFound: false, modelsFound: 0 })
        setFormData((current) => {
          const selectedModelIsAvailable = availableModels.some(
            (model) => model.id === current.transcriberModel
          )
          return selectedModelIsAvailable || availableModels.length !== 1
            ? current
            : { ...current, transcriberModel: availableModels[0].id }
        })
      })
      .catch((err) => console.error('Error loading Whisper setup:', err))
  }, [])

  useEffect(() => {
    window.api
      .getAudioOutputs()
      .then((outputs) => setAudioOutputs(Array.isArray(outputs) ? outputs : []))
      .catch((err) => console.error('Error loading audio outputs:', err))
  }, [])

  useEffect(() => {
    if (!hasLoadedSettings) return
    const timeoutId = setTimeout(() => {
      window.api
        .saveMeetingSettings(formData)
        .catch((err) => console.error('Error saving meeting settings:', err))
    }, 400)
    return () => clearTimeout(timeoutId)
  }, [formData, hasLoadedSettings])

  useEffect(() => {
    // Listen for speech-to-text transcriptions
    window.api.onTranscription((entry) => {
      if (!entry?.text) return
      setTranscription(null)
      setTranscriptionHistory((prev) => [...prev, entry])
    })

    // The sentence still being spoken, refreshed while the person talks.
    window.api.onTranscriptionPartial((entry) => {
      setTranscription(entry?.text ? entry : null)
    })

    // Progress of the careful transcription made from the recording after the meeting.
    window.api.onFinalTranscriptStatus((status) => {
      setFinalTranscriptStatus(status)
      if (status?.state !== 'done') return
      window.api
        .getSavedMeetings()
        .then((sessions) => {
          setSavedSessions(withoutDeleted(sessions, deletedMeetingsRef.current))
          setSelectedSession(
            (current) => sessions.find((session) => session.folder === current?.folder) || current
          )
        })
        .catch(() => {})
    })

    window.api.onMeetingSaved((folder) => {
      setSavedMeetingFolder(folder || '')
      window.api
        .getSavedMeetings()
        .then((sessions) => setSavedSessions(withoutDeleted(sessions, deletedMeetingsRef.current)))
        .catch(() => {})
    })

    // Listen for AI assistant updates
    window.api.onAiAnswerStart((data) => {
      // Only a finished answer becomes "previous"; one interrupted by a newer question is dropped.
      const finished = completedAnswerRef.current
      if (finished) setPreviousAnswers((current) => [finished, ...current].slice(0, 2))
      completedAnswerRef.current = null
      setCurrentQuestion(data?.question || '')
      setAiAnswer('')
      setAiProvider('')
      setAiSources([])
      setAiLatency(null)
      setIsAnswerStreaming(true)
      setAnswerStatus(data?.status || 'Buscando na base local…')
    })

    window.api.onAiAnswerDelta((data) => {
      if (data && typeof data === 'object') {
        setAiAnswer((current) => current + (data.delta || ''))
        setAiProvider(data.provider || '')
        setAiSources(Array.isArray(data.sources) ? data.sources : [])
        setAiLatency(data.latency || null)
        setAnswerStatus(data.status || 'Respondendo…')
      }
    })

    window.api.onAiAnswerStatus((status) => {
      if (typeof status === 'string') setAnswerStatus(status)
    })

    window.api.onAiAnswer((data) => {
      if (data && typeof data === 'object') {
        const sources = Array.isArray(data.sources) ? data.sources : []
        completedAnswerRef.current = {
          question: data.question || '',
          answer: data.answer,
          provider: data.provider,
          sources
        }
        if (data.question) setCurrentQuestion(data.question)
        setAiAnswer(data.answer)
        setAiProvider(data.provider)
        setAiSources(sources)
        setAiLatency(data.latency || null)
        setIsAnswerStreaming(false)
        setAnswerStatus('Resposta pronta')
      }
    })

    // Listen for audio levels
    window.api.onAudioLevel((level) => {
      setAudioLevel(level)
    })
  }, [])

  // Auto-scroll the live transcript view to the latest entry
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcriptionHistory, transcription])

  const handleStart = async () => {
    if (!formData.transcriberModel || !transcriberStatus.ready) return
    setIsPreparingSources(true)
    setSavedMeetingFolder('')
    try {
      if (window.api.isMac) await startNativeAudioCapture()
      const status = await window.api.prepareKnowledgeSources(formData)
      setIndexStatus(status)
      setSourceFilter('all')
      const meetingData = { ...formData, showLivePreview: false, transcriptCollapsed: true }
      setFormData(meetingData)
      window.api.startMeeting(meetingData)
      window.api.setTranscriptCollapsed(true)
      setIsSetupComplete(true)
    } catch (error) {
      console.error('Error preparing local knowledge sources:', error)
      setIndexStatus({
        files: 0,
        chunks: 0,
        errors: ['Não foi possível preparar as fontes locais.']
      })
    } finally {
      setIsPreparingSources(false)
    }
  }

  // Grows or shrinks the window so the answers fit, as long as automatic height is on.
  useEffect(() => {
    if (!isSetupComplete || !formData.autoHeight) return
    const area = answerAreaRef.current
    const content = answerContentRef.current
    if (!area || !content || typeof ResizeObserver === 'undefined') return
    let timer = null
    const fit = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        // Everything around the answers stays as it is; only the answers' own height changes.
        const needed = window.innerHeight - area.clientHeight + content.offsetHeight + 2
        window.api.fitWindowHeight(Math.ceil(needed))
      }, 120)
    }
    const observer = new ResizeObserver(fit)
    observer.observe(content)
    fit()
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [isSetupComplete, formData.autoHeight, formData.transcriptCollapsed])

  const handleStop = () => {
    window.api.stopMeeting()
    completedAnswerRef.current = null
    setPreviousAnswers([])
    setCurrentQuestion('')
    setTranscription(null)
    setTranscriptionHistory([])
    setAiAnswer('')
    setAiProvider('')
    setAiSources([])
    setAiLatency(null)
    setIsAnswerStreaming(false)
    setAnswerStatus('Ouvindo')
    setAudioLevel(0)
    setAudioSource('SYSTEM')
    setIsSetupComplete(false)
  }

  const handleToggleDoubt = () => {
    const nextSource = audioSource === 'SYSTEM' ? 'MIC' : 'SYSTEM'
    setAudioSource(nextSource)
    window.api.toggleAudioSource(nextSource.toLowerCase())
  }

  const handleManualQuestion = () => {
    const question = manualQuestion.trim()
    if (!question) return
    window.api.askMeetingQuestion(question)
    setManualQuestion('')
  }

  const toggleClickThrough = () => {
    const nextValue = !isClickThrough
    setIsClickThrough(nextValue)
    if (nextValue) {
      window.api.setWindowClickthrough()
    } else {
      window.api.setWindowInteractive()
    }
  }

  const selectProjectFolders = async () => {
    const result = await window.api.selectFolders(true)
    if (!result?.canceled) {
      setFormData((current) => ({ ...current, projectPaths: result.filePaths.join('\n') }))
    }
  }

  const selectObsidianFolder = async () => {
    const result = await window.api.selectFolders(false)
    if (!result?.canceled) {
      setFormData((current) => ({ ...current, obsidianVaultPath: result.filePaths[0] || '' }))
    }
  }

  const handleExportToHarness = async (session) => {
    const folder = session.folder
    setExportStatus((current) => ({ ...current, [folder]: { busy: true } }))
    setExportNotice({ text: 'Preparando exportação…' })
    try {
      let destination = formData.harnessPath
      if (!destination) {
        setExportNotice({ text: 'Selecione a pasta de destino do Harness na janela aberta.' })
        const selection = await window.api.selectFolders(false)
        destination = selection?.filePaths?.[0]
        if (selection?.canceled || !destination) {
          setExportNotice({ text: 'Exportação cancelada. Nenhum arquivo foi salvo.' })
          return
        }
        setFormData((current) => ({ ...current, harnessPath: destination }))
      }
      setExportNotice({ text: 'Salvando transcrição final no Harness…' })
      const result = await window.api.exportFinalTranscript({ folder, destination })
      if (result?.error) throw new Error(result.error)
      if (!result?.path) throw new Error('O aplicativo não confirmou o arquivo salvo.')
      setExportNotice({ text: `Transcrição enviada para: ${result.path}` })
      await loadSavedSessions()
    } catch (error) {
      setExportNotice({ error: true, text: `Não foi possível exportar: ${error.message}` })
    } finally {
      setExportStatus((current) => ({ ...current, [folder]: { busy: false } }))
    }
  }

  // The theme and the background opacity apply to the whole window, setup and meeting alike.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = formData.theme === 'light' ? 'light' : 'dark'
    const opacity = Math.min(100, Math.max(30, Number(formData.backgroundOpacity) || 62)) / 100
    root.style.setProperty('--hud-alpha', String(opacity))
    // The setup form is read, not glanced at: it stays more opaque than the meeting overlay.
    root.style.setProperty('--setup-alpha', String(Math.min(1, opacity + 0.33)))
  }, [formData.theme, formData.backgroundOpacity])

  // AI providers as the main process describes them: no key ever reaches this screen.
  const [aiState, setAiState] = useState({
    providers: [],
    primary: null,
    encryptionAvailable: true
  })
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [providerBusy, setProviderBusy] = useState('')
  const [providerMessage, setProviderMessage] = useState(null)
  const [ollamaUrl, setOllamaUrl] = useState('')

  const configuredProviders = aiState.providers.filter((provider) => provider.configured)
  const primaryProvider = configuredProviders.find((provider) => provider.id === aiState.primary)
  const agentChoice = primaryProvider ? `${primaryProvider.id}::${primaryProvider.model}` : ''

  useEffect(() => {
    window.api
      .getAiProviders()
      .then((state) => state && setAiState(state))
      .catch((err) => console.error('Error loading AI providers:', err))
  }, [])

  // Runs one settings action; the main process always answers with the fresh public state.
  const runProviderAction = async (busyKey, action, successText) => {
    setProviderBusy(busyKey)
    setProviderMessage(null)
    try {
      const result = await action()
      if (result?.state) setAiState(result.state)
      if (result?.error) throw new Error(result.error)
      const text = typeof successText === 'function' ? successText(result) : successText
      if (text) setProviderMessage({ text })
      return result
    } catch (error) {
      setProviderMessage({ error: true, text: error.message })
      return null
    } finally {
      setProviderBusy('')
    }
  }

  const providerName = (id) => aiState.providers.find((provider) => provider.id === id)?.label || id

  const addApiKey = async () => {
    const key = apiKeyInput.trim()
    if (!key) return
    const result = await runProviderAction(
      'add',
      () => window.api.addAiProviderKey(key),
      (response) =>
        `Chave ${providerName(response.provider)} verificada: ${response.models} modelo(s) disponível(is).`
    )
    if (result && !result.error) setApiKeyInput('')
  }

  const selectAgent = (value) => {
    const [provider, model] = value.split('::')
    if (provider && model)
      runProviderAction('select', () => window.api.selectAgentModel(provider, model))
  }

  const openSettings = () => {
    setProviderMessage(null)
    setOllamaUrl(aiState.providers.find((provider) => provider.id === 'ollama')?.url || '')
    setIsSettingsOpen(true)
  }

  // The meeting waiting for confirmation in the delete modal.
  const [pendingDelete, setPendingDelete] = useState(null)
  const [isDeleting, setIsDeleting] = useState(false)

  useEffect(() => {
    if (!isSettingsOpen) return
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setIsSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isSettingsOpen])

  useEffect(() => {
    if (!pendingDelete) return
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !isDeleting) setPendingDelete(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pendingDelete, isDeleting])

  const confirmDeleteMeeting = async () => {
    const session = pendingDelete
    if (!session) return
    setIsDeleting(true)
    try {
      const result = await window.api.deleteMeeting(session.filename)
      if (result?.error) throw new Error(result.error)
      if (!result?.deleted) return
      // Gone from the list at once; the reload below then brings the rest up to date.
      deletedMeetingsRef.current.add(session.filename)
      setSavedSessions((current) => current.filter((item) => item.filename !== session.filename))
      if (selectedSession?.filename === session.filename) setSelectedSession(null)
      if (savedMeetingFolder && savedMeetingFolder === session.folder) setSavedMeetingFolder('')
      setExportNotice({ text: 'Reunião movida para a Lixeira.' })
      await loadSavedSessions()
    } catch (error) {
      setExportNotice({ error: true, text: `Não foi possível apagar: ${error.message}` })
    } finally {
      setIsDeleting(false)
      setPendingDelete(null)
    }
  }

  const clearProjectFolders = () => {
    setFormData((current) => ({ ...current, projectPaths: '' }))
  }

  const clearObsidianFolder = () => {
    setFormData((current) => ({ ...current, obsidianVaultPath: '' }))
  }

  const inputStyle = {
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '10px',
    color: '#ffffff',
    padding: '0.5rem 0.75rem',
    fontSize: '0.85rem',
    fontFamily: 'inherit',
    outline: 'none',
    transition: 'border-color 0.2s, background 0.2s'
  }

  const folderButtonStyle = {
    ...inputStyle,
    width: 'auto',
    flex: '0 0 auto',
    cursor: 'pointer',
    color: '#22d3ee',
    fontWeight: '600',
    whiteSpace: 'nowrap'
  }

  if (!isSetupComplete) {
    return (
      <div
        className="app-shell setup-shell"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'rgba(15, 15, 20, var(--setup-alpha, 0.95))',
          backdropFilter: 'blur(30px)',
          borderRadius: '16px',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          color: '#ffffff',
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
          boxSizing: 'border-box',
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        <style>{`
          .markdown-content p {
            margin: 0 0 10px 0;
          }
          .markdown-content ul, .markdown-content ol {
            margin: 0 0 10px 0;
            padding-left: 20px;
          }
          .markdown-content li {
            margin-bottom: 6px;
          }
          .markdown-content code {
            background: rgba(255, 255, 255, 0.08);
            color: #22d3ee;
            padding: 2px 5px;
            border-radius: 4px;
            font-family: ui-monospace, SFMono-Regular, monospace;
            font-size: 0.85em;
          }
          .markdown-content pre {
            background: rgba(0, 0, 0, 0.25);
            padding: 12px;
            border-radius: 10px;
            overflow-x: auto;
            margin: 12px 0;
            border: 1px solid rgba(255, 255, 255, 0.04);
          }
          .markdown-content pre code {
            background: transparent;
            color: #e2e8f0;
            padding: 0;
            border-radius: 0;
            font-size: 0.85em;
          }
          .markdown-content table {
            border-collapse: collapse;
            width: 100%;
            margin: 12px 0;
          }
          .markdown-content th, .markdown-content td {
            border: 1px solid rgba(255, 255, 255, 0.08);
            padding: 8px 12px;
            text-align: left;
            font-size: 0.85rem;
          }
          .markdown-content th {
            background: rgba(255, 255, 255, 0.03);
            color: #22d3ee;
            font-weight: 600;
          }

          /* Custom scrollbar styles */
          ::-webkit-scrollbar {
            width: 5px;
            height: 5px;
          }
          ::-webkit-scrollbar-track {
            background: transparent;
          }
          ::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
          }
          ::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.2);
          }
        `}</style>

        <div
          className="setup-topbar"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flex: '0 0 30px',
            height: '30px',
            padding: '0 12px',
            background: 'rgba(30, 41, 59, 0.98)',
            borderBottom: '2px solid #22d3ee',
            WebkitAppRegion: 'drag',
            cursor: 'grab',
            userSelect: 'none'
          }}
          title="Arraste para mover a janela"
        >
          <span
            className="bar-title"
            style={{ fontSize: '0.72rem', color: '#22d3ee', fontWeight: '600' }}
          >
            Copilot de reuniões
          </span>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              WebkitAppRegion: 'no-drag'
            }}
          >
            <button
              type="button"
              onClick={openSettings}
              title="Chaves de API e modelo do agente"
              className="topbar-text-button"
            >
              Configurações
            </button>
            {isContentProtected !== null && (
              <button
                type="button"
                role="switch"
                aria-checked={isContentProtected}
                onClick={toggleContentProtection}
                title={
                  isContentProtected
                    ? 'Modo privacidade ligado: a janela não aparece em prints nem no compartilhamento de tela'
                    : 'Modo privacidade desligado: a janela aparece em prints e no compartilhamento de tela'
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'none',
                  border: 'none',
                  color: isContentProtected ? '#86efac' : '#fbbf24',
                  cursor: 'pointer',
                  fontSize: '0.7rem',
                  fontWeight: '600',
                  padding: '2px 6px'
                }}
              >
                <span className="btn-label">Privacidade</span>
                <span
                  aria-hidden="true"
                  className="keep-colors"
                  style={{
                    position: 'relative',
                    width: '26px',
                    height: '14px',
                    borderRadius: '999px',
                    background: isContentProtected ? '#22c55e' : 'rgba(148, 163, 184, 0.4)',
                    transition: 'background 0.2s'
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: '2px',
                      left: isContentProtected ? '14px' : '2px',
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      background: '#ffffff',
                      transition: 'left 0.2s'
                    }}
                  />
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={() => window.api.minimize()}
              aria-label="Minimizar janela"
              style={{
                background: 'none',
                border: 'none',
                color: '#cbd5e1',
                cursor: 'pointer',
                fontSize: '0.8rem',
                padding: '2px 6px'
              }}
            >
              ─
            </button>
            <button
              type="button"
              onClick={() => window.api.close()}
              aria-label="Fechar janela"
              style={{
                background: 'none',
                border: 'none',
                color: '#f87171',
                cursor: 'pointer',
                fontSize: '0.8rem',
                padding: '2px 6px'
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {isSettingsOpen && (
          <div className="modal-backdrop" onClick={() => setIsSettingsOpen(false)}>
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
              className="modal-card settings-card"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="settings-header">
                <h3 id="settings-title">Configurações</h3>
                <button
                  type="button"
                  className="modal-button"
                  onClick={() => setIsSettingsOpen(false)}
                >
                  Fechar
                </button>
              </div>

              <section className="settings-section">
                <h4>Aparência</h4>
                <div className="settings-segmented" role="radiogroup" aria-label="Tema">
                  {[
                    ['dark', 'Escuro'],
                    ['light', 'Claro']
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={formData.theme === value}
                      className={formData.theme === value ? 'is-active' : ''}
                      onClick={() => setFormData((current) => ({ ...current, theme: value }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="settings-range">
                  <span>
                    Opacidade do fundo durante a reunião
                    <strong>{formData.backgroundOpacity}%</strong>
                  </span>
                  <input
                    type="range"
                    min={30}
                    max={100}
                    step={5}
                    value={formData.backgroundOpacity}
                    onChange={(event) =>
                      setFormData((current) => ({
                        ...current,
                        backgroundOpacity: Number(event.target.value)
                      }))
                    }
                  />
                </label>
                <p className="settings-note">
                  Mais baixo deixa ver o que está atrás da janela; o texto continua opaco. A tela de
                  configuração fica sempre um pouco mais opaca.
                </p>
              </section>

              <section className="settings-section">
                <h4>Adicionar chave de API</h4>
                <p>
                  Cole uma chave da OpenAI, da Anthropic (Claude) ou do Google Gemini. O provedor é
                  reconhecido pela chave, que é testada antes de ser salva.
                </p>
                <form
                  className="settings-key-row"
                  onSubmit={(event) => {
                    event.preventDefault()
                    addApiKey()
                  }}
                >
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKeyInput}
                    onChange={(event) => setApiKeyInput(event.target.value)}
                    placeholder="sk-…, sk-ant-… ou AIza…"
                    aria-label="Chave de API"
                    style={inputStyle}
                  />
                  <button
                    type="submit"
                    className="modal-button modal-button-primary"
                    disabled={!apiKeyInput.trim() || Boolean(providerBusy)}
                  >
                    {providerBusy === 'add' ? 'Verificando…' : 'Adicionar'}
                  </button>
                </form>
                {providerMessage && (
                  <div
                    role={providerMessage.error ? 'alert' : 'status'}
                    className={`settings-message${providerMessage.error ? ' is-error' : ''}`}
                  >
                    {providerMessage.text}
                  </div>
                )}
                <p className="settings-note">
                  {aiState.encryptionAvailable
                    ? 'As chaves ficam criptografadas com o chaveiro do sistema e não são exibidas de novo.'
                    : 'A criptografia do sistema não está disponível; nenhuma chave pode ser salva.'}
                </p>
              </section>

              <section className="settings-section">
                <h4>Provedores</h4>
                {aiState.providers
                  .filter((provider) => provider.id !== 'ollama')
                  .map((provider) => (
                    <div key={provider.id} className="provider-row">
                      <div className="provider-info">
                        <strong>
                          {provider.label}
                          {provider.id === aiState.primary && (
                            <span className="provider-tag">Em uso</span>
                          )}
                        </strong>
                        <span>{provider.configured ? `Chave ${provider.hint}` : 'Sem chave'}</span>
                      </div>
                      {provider.configured && (
                        <div className="provider-controls">
                          <select
                            aria-label={`Modelo ${provider.label}`}
                            value={provider.model}
                            onChange={(event) =>
                              runProviderAction('select', () =>
                                window.api.selectAgentModel(provider.id, event.target.value)
                              )
                            }
                            style={inputStyle}
                          >
                            {provider.models.map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="modal-button"
                            disabled={Boolean(providerBusy)}
                            onClick={() =>
                              runProviderAction(
                                `refresh-${provider.id}`,
                                () => window.api.refreshAiModels(provider.id),
                                'Lista de modelos atualizada.'
                              )
                            }
                          >
                            {providerBusy === `refresh-${provider.id}`
                              ? 'Atualizando…'
                              : 'Atualizar'}
                          </button>
                          <button
                            type="button"
                            className="modal-button modal-button-danger"
                            disabled={Boolean(providerBusy)}
                            onClick={() =>
                              runProviderAction(
                                `remove-${provider.id}`,
                                () => window.api.removeAiProvider(provider.id),
                                `Chave ${provider.label} removida.`
                              )
                            }
                          >
                            Remover
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
              </section>

              {(() => {
                const ollama = aiState.providers.find((provider) => provider.id === 'ollama')
                if (!ollama) return null
                return (
                  <section className="settings-section">
                    <h4>Ollama local</h4>
                    <p>Modelos rodando no próprio computador; nada é enviado para fora.</p>
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={ollama.enabled}
                        disabled={Boolean(providerBusy)}
                        onChange={(event) =>
                          runProviderAction(
                            'ollama',
                            () =>
                              window.api.configureOllama({
                                enabled: event.target.checked,
                                url: ollamaUrl
                              }),
                            event.target.checked ? 'Ollama conectado.' : 'Ollama desativado.'
                          )
                        }
                      />
                      Usar o Ollama
                    </label>
                    <div className="settings-key-row">
                      <input
                        value={ollamaUrl}
                        onChange={(event) => setOllamaUrl(event.target.value)}
                        placeholder="http://localhost:11434"
                        aria-label="Endereço do Ollama"
                        style={inputStyle}
                      />
                      <button
                        type="button"
                        className="modal-button"
                        disabled={Boolean(providerBusy)}
                        onClick={() =>
                          runProviderAction(
                            'ollama',
                            () => window.api.configureOllama({ enabled: true, url: ollamaUrl }),
                            (response) =>
                              `Ollama conectado: ${response.state.providers.find((item) => item.id === 'ollama').models.length} modelo(s).`
                          )
                        }
                      >
                        {providerBusy === 'ollama' ? 'Conectando…' : 'Detectar modelos'}
                      </button>
                    </div>
                    {ollama.configured && (
                      <div className="provider-controls">
                        <select
                          aria-label="Modelo do Ollama"
                          value={ollama.model}
                          onChange={(event) =>
                            runProviderAction('select', () =>
                              window.api.selectAgentModel('ollama', event.target.value)
                            )
                          }
                          style={inputStyle}
                        >
                          {ollama.models.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                        {ollama.id === aiState.primary && (
                          <span className="provider-tag">Em uso</span>
                        )}
                      </div>
                    )}
                  </section>
                )
              })()}
            </div>
          </div>
        )}

        {pendingDelete && (
          <div className="modal-backdrop" onClick={() => !isDeleting && setPendingDelete(null)}>
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-modal-title"
              aria-describedby="delete-modal-text"
              className="modal-card"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="delete-modal-title">Apagar esta reunião?</h3>
              <p className="modal-meeting text-content">
                {pendingDelete.data.meeting?.context || 'Reunião sem contexto'}
                {pendingDelete.data.timestamp && (
                  <span>
                    {new Date(pendingDelete.data.timestamp).toLocaleString('pt-BR', {
                      dateStyle: 'short',
                      timeStyle: 'short'
                    })}
                  </span>
                )}
              </p>
              <p id="delete-modal-text">
                O áudio, as transcrições e as respostas desta reunião vão para a Lixeira. Dá para
                recuperar por lá, se precisar.
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  autoFocus
                  disabled={isDeleting}
                  onClick={() => setPendingDelete(null)}
                  className="modal-button"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={confirmDeleteMeeting}
                  className="modal-button modal-button-danger"
                >
                  {isDeleting ? 'Apagando…' : 'Mover para a Lixeira'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Drawer overlay for inspecting a past session */}
        {selectedSession && (
          <div
            style={{
              position: 'absolute',
              top: '30px',
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(10, 10, 15, 0.98)',
              borderRadius: '0 0 16px 16px',
              padding: 'clamp(12px, 3vw, 24px)',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 100
            }}
          >
            <div
              className="session-drawer-header"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '20px'
              }}
            >
              <div className="text-content">
                <h3 style={{ margin: 0, fontSize: '1.3rem', color: '#22d3ee', fontWeight: '700' }}>
                  Histórico da reunião: {selectedSession.data.meeting?.context || 'Sem contexto'}
                </h3>
                <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: '#64748b' }}>
                  Gravada em {new Date(selectedSession.data.timestamp).toLocaleString('pt-BR')}
                </p>
              </div>
              <button
                onClick={() => setSelectedSession(null)}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#ffffff',
                  padding: '8px 18px',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  fontWeight: '600',
                  transition: 'background 0.2s'
                }}
                onMouseEnter={(e) => (e.target.style.background = 'rgba(255, 255, 255, 0.1)')}
                onMouseLeave={(e) => (e.target.style.background = 'rgba(255, 255, 255, 0.05)')}
              >
                Fechar
              </button>
            </div>

            <div style={{ flex: 1, display: 'flex', gap: '20px', overflow: 'hidden' }}>
              {/* Left Box: Transcript history */}
              <div
                style={{
                  flex: 1,
                  background: 'rgba(255, 255, 255, 0.01)',
                  borderRadius: '16px',
                  padding: '16px',
                  border: '1px solid rgba(255, 255, 255, 0.03)',
                  overflowY: 'auto'
                }}
              >
                <h4
                  style={{
                    margin: '0 0 12px 0',
                    fontSize: '0.95rem',
                    color: '#cbd5e1',
                    fontWeight: '600'
                  }}
                >
                  Histórico completo da transcrição
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {selectedSession.folder && (
                    <button
                      onClick={() => window.api.openMeetingFolder(selectedSession.folder)}
                      style={{
                        alignSelf: 'flex-start',
                        background: 'rgba(34, 211, 238, 0.1)',
                        border: '1px solid rgba(34, 211, 238, 0.25)',
                        color: '#67e8f9',
                        padding: '6px 12px',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        fontSize: '0.8rem'
                      }}
                    >
                      Abrir pasta com áudio e transcrição
                    </button>
                  )}
                  {selectedSession.folder && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        flexWrap: 'wrap'
                      }}
                    >
                      <button
                        disabled={finalTranscriptLabel(selectedSession.folder).running}
                        onClick={() => window.api.generateFinalTranscript(selectedSession.folder)}
                        style={{
                          background: 'rgba(74, 222, 128, 0.1)',
                          border: '1px solid rgba(74, 222, 128, 0.25)',
                          color: '#86efac',
                          padding: '6px 12px',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          fontSize: '0.8rem'
                        }}
                      >
                        {selectedSession.data.finalTranscript
                          ? 'Refazer transcrição final'
                          : 'Gerar transcrição final'}
                      </button>
                      <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
                        {finalTranscriptLabel(selectedSession.folder).text ||
                          (selectedSession.data.finalTranscript
                            ? 'Mostrando a transcrição final, feita a partir da gravação.'
                            : 'Mostrando a transcrição feita ao vivo.')}
                      </span>
                    </div>
                  )}
                  {Array.isArray(
                    selectedSession.data.finalTranscript || selectedSession.data.transcript
                  )
                    ? (selectedSession.data.finalTranscript || selectedSession.data.transcript).map(
                        (entry, idx) => (
                          <div
                            key={idx}
                            style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: '1.5' }}
                          >
                            <strong
                              style={{ color: entry.speaker === 'client' ? '#67e8f9' : '#cbd5e1' }}
                            >
                              {{ client: 'Cliente', me: 'Eu', manual: 'Pergunta manual' }[
                                entry.speaker
                              ] || 'Participante'}
                              :
                            </strong>{' '}
                            {entry.text}
                          </div>
                        )
                      )
                    : (selectedSession.data.conversationHistory || [])
                        .filter((msg) => msg.role === 'user')
                        .map((msg, idx) => (
                          <div
                            key={idx}
                            style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: '1.5' }}
                          >
                            {msg.content}
                          </div>
                        ))}
                </div>
              </div>

              {/* Right Box: AI responses */}
              <div
                style={{
                  flex: 1.2,
                  background: 'rgba(34, 211, 238, 0.01)',
                  borderRadius: '16px',
                  padding: '16px',
                  border: '1px solid rgba(34, 211, 238, 0.04)',
                  overflowY: 'auto'
                }}
                className="markdown-content"
              >
                <h4
                  style={{
                    margin: '0 0 12px 0',
                    fontSize: '0.95rem',
                    color: '#22d3ee',
                    fontWeight: '600'
                  }}
                >
                  Sugestões geradas pela IA
                </h4>
                {(selectedSession.data.conversationHistory || [])
                  .filter((msg) => msg.role === 'model' || msg.role === 'assistant')
                  .map((msg, idx) => (
                    <div
                      key={idx}
                      style={{
                        marginBottom: '16px',
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                        paddingBottom: '12px'
                      }}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        <div className="setup-body">
          {/* Config Form Fields */}
          <div>
            <h2
              style={{
                margin: '0 0 4px 0',
                fontSize: '1.3rem',
                color: '#22d3ee',
                fontWeight: '700',
                letterSpacing: '0.5px'
              }}
            >
              Configuração do Copilot
            </h2>
            <p style={{ margin: '0 0 1rem 0', fontSize: '0.82rem', color: '#64748b' }}>
              Descreva a conversa e escolha as fontes locais que poderão ajudar nas respostas.
            </p>

            <div className="setup-form-columns" style={{ display: 'flex', gap: '1.5rem' }}>
              {/* Meeting and transcription */}
              <div className="setup-column">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                    Contexto da reunião
                  </label>
                  <textarea
                    value={formData.meetingContext}
                    onChange={(e) => setFormData({ ...formData, meetingContext: e.target.value })}
                    placeholder="Ex.: daily da equipe, alinhamento técnico ou conversa com cliente; pauta e termos importantes..."
                    style={{ ...inputStyle, height: '88px', resize: 'none' }}
                    onFocus={(e) => (e.target.style.borderColor = 'rgba(34, 211, 238, 0.5)')}
                    onBlur={(e) => (e.target.style.borderColor = 'rgba(255, 255, 255, 0.08)')}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                    Glossário da transcrição
                  </label>
                  <textarea
                    value={formData.terminology}
                    onChange={(e) => setFormData({ ...formData, terminology: e.target.value })}
                    placeholder={'Paketá: paqueta, paceta\nDataprev: data prev'}
                    spellCheck={false}
                    style={{
                      ...inputStyle,
                      height: '120px',
                      resize: 'vertical',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '0.78rem'
                    }}
                    onFocus={(e) => (e.target.style.borderColor = 'rgba(34, 211, 238, 0.5)')}
                    onBlur={(e) => (e.target.style.borderColor = 'rgba(255, 255, 255, 0.08)')}
                  />
                  <span style={{ fontSize: '0.72rem', color: '#64748b', lineHeight: 1.4 }}>
                    Um termo por linha, como <code>Nome certo: variação 1, variação 2</code>. Os
                    nomes próprios das notas do vault e dos projetos também são reconhecidos
                    automaticamente.
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                    Modelo de transcrição
                  </label>
                  <select
                    value={formData.transcriberModel}
                    onChange={(e) => setFormData({ ...formData, transcriberModel: e.target.value })}
                    style={inputStyle}
                  >
                    <option value="" disabled>
                      {transcriptionModels.length
                        ? 'Selecione um modelo'
                        : 'Nenhum modelo encontrado'}
                    </option>
                    {transcriptionModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                  <span
                    style={{
                      fontSize: '0.72rem',
                      color: transcriptionModels.length ? '#64748b' : '#f87171'
                    }}
                  >
                    {transcriptionModels.length
                      ? 'Modelo Whisper local usado para transformar áudio em texto.'
                      : 'Nenhum modelo Whisper foi encontrado na pasta models.'}
                    {!transcriberStatus.binaryFound && (
                      <span style={{ display: 'block', marginTop: '4px' }}>
                        Adaptador Whisper ausente. Execute <code>npm run whisper:build</code>.
                      </span>
                    )}
                  </span>
                </div>
                <div className="setup-pair">
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                      Idioma
                    </label>
                    <select
                      value={formData.language}
                      onChange={(e) => setFormData({ ...formData, language: e.target.value })}
                      style={inputStyle}
                    >
                      <option value="pt-BR">Português</option>
                      <option value="en-US">Inglês</option>
                    </select>
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                      Modelo do agente
                    </label>
                    <select
                      value={agentChoice}
                      disabled={!configuredProviders.length}
                      onChange={(event) => selectAgent(event.target.value)}
                      style={inputStyle}
                    >
                      {!configuredProviders.length && (
                        <option value="">Nenhum provedor configurado</option>
                      )}
                      {configuredProviders.map((provider) => (
                        <optgroup key={provider.id} label={provider.label}>
                          {provider.models.map((model) => (
                            <option key={model} value={`${provider.id}::${model}`}>
                              {model}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="agent-summary">
                  <span className="text-content">
                    {primaryProvider
                      ? `Respostas com ${primaryProvider.short} (${primaryProvider.model})${
                          primaryProvider.hint ? `, chave ${primaryProvider.hint}` : ''
                        }.${
                          configuredProviders.length > 1
                            ? ` Se falhar, tenta ${configuredProviders
                                .filter((provider) => provider.id !== primaryProvider.id)
                                .map((provider) => provider.short)
                                .join(', ')}.`
                            : ''
                        }`
                      : 'Adicione uma chave de API ou ative o Ollama para o copiloto responder.'}
                  </span>
                  <button type="button" style={folderButtonStyle} onClick={openSettings}>
                    Configurar provedores
                  </button>
                </div>
                <span style={{ fontSize: '0.72rem', color: '#64748b', lineHeight: 1.4 }}>
                  A transcrição é sempre local. Com um provedor em nuvem (OpenAI, Gemini, Claude), a
                  pergunta e os trechos das notas usados na resposta são enviados a ele; com o
                  Ollama, nada sai do computador.
                </span>
              </div>

              {/* Local sources and audio */}
              <div className="setup-column">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                    Projetos para consultar
                  </label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button type="button" onClick={selectProjectFolders} style={folderButtonStyle}>
                      Buscar pastas
                    </button>
                    <button
                      type="button"
                      onClick={clearProjectFolders}
                      disabled={!formData.projectPaths}
                      style={{
                        ...folderButtonStyle,
                        color: '#94a3b8',
                        cursor: formData.projectPaths ? 'pointer' : 'default'
                      }}
                    >
                      Limpar
                    </button>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                    {formData.projectPaths
                      ? `${formData.projectPaths.split('\n').filter(Boolean).length} projeto(s) selecionado(s):`
                      : 'Nenhum projeto selecionado. Opcional: escolha até duas pastas.'}
                  </span>
                  {formData.projectPaths
                    .split('\n')
                    .filter(Boolean)
                    .map((path) => (
                      <div key={path} className="source-path" title={path}>
                        {path}
                      </div>
                    ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                    Vault do Obsidian
                  </label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button type="button" onClick={selectObsidianFolder} style={folderButtonStyle}>
                      Buscar pasta
                    </button>
                    <button
                      type="button"
                      onClick={clearObsidianFolder}
                      disabled={!formData.obsidianVaultPath}
                      style={{
                        ...folderButtonStyle,
                        color: '#94a3b8',
                        cursor: formData.obsidianVaultPath ? 'pointer' : 'default'
                      }}
                    >
                      Limpar
                    </button>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                    {formData.obsidianVaultPath
                      ? 'Vault selecionado:'
                      : 'Nenhum vault selecionado (opcional).'}
                  </span>
                  {formData.obsidianVaultPath && (
                    <div className="source-path" title={formData.obsidianVaultPath}>
                      {formData.obsidianVaultPath}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                    Destino das transcrições no Harness
                  </label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button
                      type="button"
                      style={folderButtonStyle}
                      onClick={async () => {
                        const result = await window.api.selectFolders(false)
                        if (!result?.canceled)
                          setFormData((current) => ({
                            ...current,
                            harnessPath: result.filePaths[0] || ''
                          }))
                      }}
                    >
                      Selecionar pasta
                    </button>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                    {formData.harnessPath
                      ? 'Se houver uma subpasta HARNESS, o Markdown será salvo dentro dela.'
                      : 'Nenhuma pasta selecionada. Opcional: destino das transcrições finais.'}
                  </span>
                  {formData.harnessPath && (
                    <div className="source-path" title={formData.harnessPath}>
                      {formData.harnessPath}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                    Saída de áudio para ouvir
                  </label>
                  <select
                    value={formData.audioOutputDevice}
                    onChange={(e) =>
                      setFormData({ ...formData, audioOutputDevice: e.target.value })
                    }
                    style={inputStyle}
                    title="O copilot ouvirá o monitor desta saída"
                  >
                    <option value="">Saída padrão do sistema</option>
                    {audioOutputs.map((output) => (
                      <option key={output.id} value={output.id}>
                        {output.label}
                      </option>
                    ))}
                  </select>
                  <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                    O copilot ouvirá o áudio reproduzido nessa saída.
                  </span>
                </div>
                {indexStatus && (
                  <div
                    style={{
                      fontSize: '0.78rem',
                      lineHeight: '1.45',
                      color: indexStatus.errors?.length ? '#fbbf24' : '#86efac',
                      padding: '9px 11px',
                      borderRadius: '10px',
                      background: 'rgba(255,255,255,0.03)'
                    }}
                  >
                    Índice local: {indexStatus.files} arquivo(s), {indexStatus.chunks} trecho(s)
                    {indexStatus.vocabularyTerms
                      ? `, ${indexStatus.vocabularyTerms} nome(s) próprio(s) aprendido(s)`
                      : ''}
                    .{indexStatus.errors?.length ? ` ${indexStatus.errors[0]}` : ''}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Saved Sessions list at the bottom */}
          <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '10px' }}>
            <h4
              style={{
                margin: '0 0 8px 0',
                fontSize: '0.85rem',
                color: '#cbd5e1',
                fontWeight: '600'
              }}
            >
              Histórico de sessões salvas
            </h4>
            {exportNotice && (
              <div
                role={exportNotice.error ? 'alert' : 'status'}
                style={{
                  padding: '10px',
                  marginBottom: '10px',
                  borderRadius: '8px',
                  background: 'rgba(255,255,255,0.06)',
                  color: exportNotice.error ? '#f87171' : '#86efac',
                  fontSize: '0.8rem',
                  overflowWrap: 'anywhere',
                  userSelect: 'text'
                }}
              >
                {exportNotice.text}
              </div>
            )}
            {savedMeetingFolder && (
              <button
                onClick={() => window.api.openMeetingFolder(savedMeetingFolder)}
                style={{
                  margin: '0 0 8px 0',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: '#4ade80',
                  cursor: 'pointer',
                  fontSize: '0.78rem',
                  textAlign: 'left'
                }}
              >
                Áudio e transcrição salvos em {savedMeetingFolder}
                {finalTranscriptLabel(savedMeetingFolder).text &&
                  ` — ${finalTranscriptLabel(savedMeetingFolder).text}`}
                {finalTranscriptStatus?.folder === savedMeetingFolder &&
                  finalTranscriptStatus.state === 'done' &&
                  ' — transcrição final pronta'}
              </button>
            )}
            <div className="session-grid">
              {savedSessions.length === 0 ? (
                <div
                  style={{
                    fontSize: '0.8rem',
                    color: '#64748b',
                    fontStyle: 'italic',
                    padding: '10px 0'
                  }}
                >
                  Nenhuma reunião salva. Inicie uma reunião para registrar uma.
                </div>
              ) : (
                savedSessions.map((session, index) => (
                  <div
                    key={index}
                    onClick={(event) => {
                      if (event.target.closest('button, input, a, [data-session-action]')) return
                      setSelectedSession(session)
                    }}
                    style={{
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid rgba(255, 255, 255, 0.05)',
                      borderRadius: '12px',
                      padding: '8px 12px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      boxSizing: 'border-box'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                      e.currentTarget.style.borderColor = 'rgba(34, 211, 238, 0.3)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)'
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.05)'
                    }}
                  >
                    <div
                      style={{
                        fontSize: '0.8rem',
                        color: '#f1f5f9',
                        fontWeight: '600',
                        textOverflow: 'ellipsis',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {session.data.meeting?.context || 'Reunião sem contexto'}
                    </div>
                    {harnessBadge(session)}
                    <div
                      className="session-card-details"
                      style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '2px' }}
                    >
                      {session.data.meeting?.obsidianVaultPath || 'Sem vault configurado'}
                    </div>
                    <div
                      data-session-action
                      className="session-actions"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {session.folder && Array.isArray(session.data.finalTranscript) && (
                        <button
                          type="button"
                          style={folderButtonStyle}
                          disabled={exportStatus[session.folder]?.busy}
                          title={
                            formData.harnessPath || 'Clique para selecionar o destino do Harness'
                          }
                          onClick={(event) => {
                            event.stopPropagation()
                            handleExportToHarness(session)
                          }}
                        >
                          {exportStatus[session.folder]?.busy
                            ? 'Salvando…'
                            : session.data.harnessExports?.length
                              ? 'Enviar de novo'
                              : 'Enviar para o Harness'}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label="Apagar reunião"
                        title="Mover esta reunião para a Lixeira"
                        style={{ ...folderButtonStyle, color: '#f87171' }}
                        onClick={(event) => {
                          event.stopPropagation()
                          setPendingDelete(session)
                        }}
                      >
                        Apagar
                      </button>
                    </div>
                    <div style={{ fontSize: '0.65rem', color: '#64748b', marginTop: '6px' }}>
                      {new Date(session.data.timestamp).toLocaleDateString('pt-BR')} às{' '}
                      {new Date(session.data.timestamp).toLocaleTimeString('pt-BR', {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
            <button
              onClick={handleStart}
              disabled={
                isPreparingSources || !transcriberStatus.ready || !formData.transcriberModel
              }
              style={{
                background: 'linear-gradient(135deg, #06b6d4 0%, #0891b2 100%)',
                border: 'none',
                color: '#ffffff',
                padding: '0.6rem 1.5rem',
                borderRadius: '12px',
                fontSize: '0.88rem',
                fontWeight: '600',
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(6, 182, 212, 0.35)',
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => (e.target.style.boxShadow = '0 6px 20px rgba(6, 182, 212, 0.5)')}
              onMouseLeave={(e) =>
                (e.target.style.boxShadow = '0 4px 14px rgba(6, 182, 212, 0.35)')
              }
            >
              {isPreparingSources
                ? 'Preparando fontes locais…'
                : !transcriberStatus.binaryFound
                  ? 'Adaptador Whisper ausente'
                  : transcriptionModels.length === 0
                    ? 'Modelo Whisper ausente'
                    : 'Iniciar reunião'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`app-shell hud-shell${formData.transcriptCollapsed ? ' transcript-collapsed' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(15, 15, 20, var(--hud-alpha, 0.62))',
        backdropFilter: 'blur(16px)',
        borderRadius: '16px',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        color: '#ffffff',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
        overflow: 'hidden'
      }}
    >
      <style>{`
        .window-control-btn {
          -webkit-app-region: no-drag !important;
          cursor: pointer !important;
          font-size: 0.8rem !important;
          padding: 2px 6px !important;
          user-select: none !important;
        }

        .markdown-content p {
          margin: 0 0 10px 0;
        }
        .markdown-content ul, .markdown-content ol {
          margin: 0 0 10px 0;
          padding-left: 20px;
        }
        .markdown-content li {
          margin-bottom: 6px;
        }
        .markdown-content code {
          background: rgba(255, 255, 255, 0.08);
          color: #22d3ee;
          padding: 2px 5px;
          border-radius: 4px;
          font-family: ui-monospace, SFMono-Regular, monospace;
          font-size: 0.85em;
        }
        .markdown-content pre {
          background: rgba(0, 0, 0, 0.25);
          padding: 12px;
          border-radius: 10px;
          overflow-x: auto;
          margin: 12px 0;
          border: 1px solid rgba(255, 255, 255, 0.04);
        }
        .markdown-content pre code {
          background: transparent;
          color: #e2e8f0;
          padding: 0;
          border-radius: 0;
          font-size: 0.85em;
        }
        .markdown-content table {
          border-collapse: collapse;
          width: 100%;
          margin: 12px 0;
        }
        .markdown-content th, .markdown-content td {
          border: 1px solid rgba(255, 255, 255, 0.08);
          padding: 8px 12px;
          text-align: left;
          font-size: 0.85rem;
        }
        .markdown-content th {
          background: rgba(255, 255, 255, 0.03);
          color: #22d3ee;
          font-weight: 600;
        }
      `}</style>

      {/* Draggable Top Bar */}
      <div
        className="hud-topbar"
        onMouseEnter={() => window.api.setWindowInteractive()}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '8px',
          padding: '0 10px',
          height: '32px',
          flex: '0 0 32px',
          background: 'rgba(30, 41, 59, 0.86)',
          borderBottom: '2px solid #22d3ee',
          WebkitAppRegion: 'drag',
          userSelect: 'none',
          boxSizing: 'border-box',
          boxShadow: '0 4px 20px rgba(34, 211, 238, 0.15)',
          transition: 'all 0.3s ease'
        }}
      >
        <span
          className="hud-topbar-title bar-title"
          style={{ fontSize: '0.75rem', color: '#22d3ee', fontWeight: '600' }}
          title="Copilot de reuniões com IA — arraste para mover"
        >
          Copilot de reuniões
        </span>
        <div
          className="hud-window-controls"
          style={{ display: 'flex', alignItems: 'center', gap: '4px', WebkitAppRegion: 'no-drag' }}
        >
          <button
            type="button"
            onClick={toggleClickThrough}
            className="window-control-btn"
            title={
              isClickThrough ? 'Ativar cliques na janela' : 'Deixar cliques passarem para trás'
            }
            style={{
              background: isClickThrough ? 'rgba(34, 211, 238, 0.18)' : 'none',
              border: '1px solid rgba(34, 211, 238, 0.3)',
              borderRadius: '6px',
              color: '#cbd5e1',
              cursor: 'pointer',
              fontSize: '0.7rem',
              padding: '3px 8px',
              WebkitAppRegion: 'no-drag'
            }}
          >
            {isClickThrough ? 'Interagir' : 'Atravessar'}
          </button>
          <span
            onClick={handleStop}
            className="window-control-btn"
            style={{
              background: 'rgba(239, 68, 68, 0.12)',
              color: '#ef4444',
              padding: '4px 10px',
              borderRadius: '6px',
              border: '1px solid rgba(239, 68, 68, 0.35)',
              marginRight: '4px',
              fontSize: '0.75rem',
              fontWeight: '600',
              cursor: 'pointer',
              transition: 'all 0.2s',
              WebkitAppRegion: 'no-drag'
            }}
            title="Encerrar reunião e salvar a gravação"
            onMouseEnter={(e) => {
              e.target.style.background = 'rgba(239, 68, 68, 0.25)'
              e.target.style.transform = 'scale(1.03)'
            }}
            onMouseLeave={(e) => {
              e.target.style.background = 'rgba(239, 68, 68, 0.12)'
              e.target.style.transform = 'scale(1.0)'
            }}
          >
            Encerrar
          </span>
          <button
            onClick={() => window.api.minimize()}
            className="window-control-btn"
            title="Minimizar"
            style={{
              background: 'none',
              border: 'none',
              color: '#cbd5e1',
              cursor: 'pointer',
              fontSize: '0.85rem',
              padding: '4px 8px',
              transition: 'color 0.2s, transform 0.2s',
              WebkitAppRegion: 'no-drag'
            }}
            onMouseEnter={(e) => {
              e.target.style.color = '#22d3ee'
              e.target.style.transform = 'scale(1.1)'
            }}
            onMouseLeave={(e) => {
              e.target.style.color = '#cbd5e1'
              e.target.style.transform = 'scale(1.0)'
            }}
          >
            ─
          </button>
          <button
            onClick={() => window.api.maximize()}
            className="window-control-btn"
            title="Maximizar"
            style={{
              background: 'none',
              border: 'none',
              color: '#cbd5e1',
              cursor: 'pointer',
              fontSize: '0.85rem',
              padding: '4px 8px',
              transition: 'color 0.2s, transform 0.2s',
              WebkitAppRegion: 'no-drag'
            }}
            onMouseEnter={(e) => {
              e.target.style.color = '#22d3ee'
              e.target.style.transform = 'scale(1.1)'
            }}
            onMouseLeave={(e) => {
              e.target.style.color = '#cbd5e1'
              e.target.style.transform = 'scale(1.0)'
            }}
          >
            ▢
          </button>
          <button
            onClick={() => window.api.close()}
            className="window-control-btn"
            title="Fechar"
            style={{
              background: 'none',
              border: 'none',
              color: '#f87171',
              cursor: 'pointer',
              fontSize: '0.85rem',
              padding: '4px 8px',
              transition: 'color 0.2s, transform 0.2s',
              WebkitAppRegion: 'no-drag'
            }}
            onMouseEnter={(e) => {
              e.target.style.color = '#ef4444'
              e.target.style.transform = 'scale(1.1)'
            }}
            onMouseLeave={(e) => {
              e.target.style.color = '#f87171'
              e.target.style.transform = 'scale(1.0)'
            }}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="hud-options">
        <button
          type="button"
          onClick={() => {
            const collapsed = !formData.transcriptCollapsed
            setFormData((current) => ({ ...current, transcriptCollapsed: collapsed }))
            window.api.setTranscriptCollapsed(collapsed)
          }}
          aria-expanded={!formData.transcriptCollapsed}
          title={
            formData.transcriptCollapsed
              ? 'Mostrar a transcrição ao vivo'
              : 'Ocultar a transcrição ao vivo (ela continua sendo gravada)'
          }
        >
          {formData.transcriptCollapsed ? '▶' : '◀'}
          <span className="opt-label"> Transcrição</span>
        </button>
        <label title="Debug: mostra em verde o texto provisório da fala em andamento">
          <input
            type="checkbox"
            checked={formData.showLivePreview}
            onChange={(e) =>
              setFormData((current) => ({ ...current, showLivePreview: e.target.checked }))
            }
          />{' '}
          <span className="opt-label">Prévia</span>
        </label>
        <label title="Responder automaticamente às perguntas ouvidas. Desligado, só a pergunta manual consome tokens.">
          <input
            type="checkbox"
            checked={formData.autoAnswer}
            onChange={(e) => {
              const enabled = e.target.checked
              setFormData((current) => ({ ...current, autoAnswer: enabled }))
              window.api.setAutoAnswer(enabled)
              if (!enabled) {
                setIsAnswerStreaming(false)
                setAnswerStatus('Respostas automáticas desativadas')
              } else setAnswerStatus('Ouvindo')
            }}
          />{' '}
          <span className="opt-label">Auto</span>
        </label>
        <label title="Quantas respostas mostrar: a atual e até duas anteriores">
          <span className="opt-label">Respostas</span>
          <select
            className="answer-count-select"
            value={formData.answerCount}
            onChange={(event) =>
              setFormData((current) => ({ ...current, answerCount: Number(event.target.value) }))
            }
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <label title="Ajustar a altura da janela ao tamanho das respostas">
          <input
            type="checkbox"
            checked={formData.autoHeight}
            onChange={(event) =>
              setFormData((current) => ({ ...current, autoHeight: event.target.checked }))
            }
          />{' '}
          <span className="opt-label">Altura</span>
        </label>
        <label title="Mostrar o campo para digitar uma pergunta ao copiloto">
          <input
            type="checkbox"
            checked={formData.showManualQuestion}
            onChange={(event) =>
              setFormData((current) => ({ ...current, showManualQuestion: event.target.checked }))
            }
          />{' '}
          <span className="opt-label">Pergunta</span>
        </label>
      </div>

      {/* Main HUD Dashboard */}
      <div
        className="hud-dashboard"
        style={{
          flex: 1,
          display: 'flex',
          gap: 'clamp(8px, 1.6vw, 16px)',
          padding: 'clamp(8px, 1.8vw, 18px)',
          overflow: 'hidden',
          boxSizing: 'border-box'
        }}
      >
        {/* Left Column: Live Audio Transcription History */}
        {!formData.transcriptCollapsed && (
          <div
            className="hud-panel"
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              background: 'rgba(255, 255, 255, 0.02)',
              borderRadius: '14px',
              padding: 'clamp(10px, 1.6vw, 16px)',
              border: '1px solid rgba(255, 255, 255, 0.04)',
              overflow: 'hidden'
            }}
          >
            <div
              className="hud-panel-header"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '14px',
                flexWrap: 'wrap',
                gap: '10px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h3
                  style={{
                    margin: 0,
                    fontSize: '0.95rem',
                    color: '#cbd5e1',
                    fontWeight: '600',
                    letterSpacing: '0.5px'
                  }}
                >
                  Transcrição
                </h3>
                {renderContentProtectionBadge(isContentProtected)}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {/* Audio Visualizer Badge */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    background:
                      audioSource === 'MIC'
                        ? 'rgba(239, 68, 68, 0.15)'
                        : 'rgba(34, 211, 238, 0.15)',
                    border:
                      audioSource === 'MIC'
                        ? '1px solid rgba(239, 68, 68, 0.3)'
                        : '1px solid rgba(34, 211, 238, 0.3)',
                    borderRadius: '20px',
                    padding: '4px 10px',
                    transition: 'all 0.3s ease'
                  }}
                >
                  <div
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: audioSource === 'MIC' ? '#ef4444' : '#22d3ee',
                      transform: `scale(${1 + (audioLevel / 100) * 0.8})`,
                      boxShadow: audioSource === 'MIC' ? '0 0 10px #ef4444' : '0 0 10px #22d3ee',
                      transition: 'transform 0.1s ease-out'
                    }}
                  />
                  <span
                    style={{
                      fontSize: '0.7rem',
                      fontWeight: '700',
                      color: audioSource === 'MIC' ? '#fca5a5' : '#99f6e4',
                      letterSpacing: '0.5px'
                    }}
                  >
                    {audioSource}
                  </span>
                </div>

                {/* Ask Doubt Button */}
                <button
                  onClick={handleToggleDoubt}
                  title={
                    audioSource === 'MIC'
                      ? 'Parar de enviar sua fala ao copiloto'
                      : 'Fazer uma pergunta ao copiloto falando no microfone'
                  }
                  style={{
                    background:
                      audioSource === 'MIC'
                        ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
                        : 'rgba(255, 255, 255, 0.05)',
                    border: audioSource === 'MIC' ? 'none' : '1px solid rgba(255, 255, 255, 0.08)',
                    color: '#ffffff',
                    padding: '6px 12px',
                    borderRadius: '10px',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                    fontWeight: '600',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    boxShadow:
                      audioSource === 'MIC' ? '0 4px 12px rgba(239, 68, 68, 0.35)' : 'none',
                    transition: 'all 0.2s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'scale(1.03)'
                    if (audioSource !== 'MIC') {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'scale(1.0)'
                    if (audioSource !== 'MIC') {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                    }
                  }}
                >
                  <span>{audioSource === 'MIC' ? 'Cancelar' : 'Perguntar'}</span>
                </button>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                paddingRight: '6px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
              }}
            >
              {transcriptionHistory.map((entry, index) => (
                <div
                  key={index}
                  style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: '1.5' }}
                >
                  <strong style={{ color: entry.speaker === 'client' ? '#67e8f9' : '#cbd5e1' }}>
                    {entry.label}:
                  </strong>{' '}
                  {entry.text}
                </div>
              ))}
              {formData.showLivePreview && transcription && (
                <div
                  style={{
                    fontSize: '0.88rem',
                    color: '#4ade80',
                    fontWeight: '600',
                    lineHeight: '1.5'
                  }}
                >
                  {transcription.label}: {transcription.text}...
                </div>
              )}
              <div ref={transcriptEndRef} />
            </div>
          </div>
        )}

        {/* Right Column: AI Copilot Assistant Suggestions */}
        <div
          className="hud-panel"
          style={{
            flex: 1.4,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(34, 211, 238, 0.02)',
            borderRadius: '14px',
            padding: 'clamp(10px, 1.6vw, 16px)',
            border: '1px solid rgba(34, 211, 238, 0.08)',
            overflow: 'hidden'
          }}
        >
          <div
            className="hud-panel-header"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '14px',
              gap: '10px',
              flexWrap: 'wrap'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div>
                <h3
                  style={{
                    margin: 0,
                    fontSize: '0.95rem',
                    color: '#22d3ee',
                    fontWeight: '600',
                    letterSpacing: '0.5px'
                  }}
                >
                  Resposta
                </h3>
                {indexStatus && (
                  <div
                    className="bar-title hide-narrow"
                    title={`Base local: ${indexStatus.files} arquivos, ${indexStatus.chunks} trechos`}
                    style={{
                      fontSize: '0.66rem',
                      color: indexStatus.errors?.length ? '#fbbf24' : '#86efac',
                      marginTop: '2px'
                    }}
                  >
                    {indexStatus.files} arquivos
                  </div>
                )}
                <div
                  className="bar-title"
                  title={answerStatus}
                  style={{ fontSize: '0.66rem', color: '#94a3b8', marginTop: '2px' }}
                >
                  {answerStatus}
                </div>
              </div>
              {renderContentProtectionBadge(isContentProtected)}
            </div>
            {aiProvider && (
              <span
                className="hide-narrow"
                title={`Fornecido por ${aiProvider}`}
                style={{
                  fontSize: '0.68rem',
                  color: '#64748b',
                  background: 'rgba(34, 211, 238, 0.08)',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  border: '1px solid rgba(34, 211, 238, 0.15)',
                  fontWeight: '500'
                }}
              >
                {aiProvider}
              </span>
            )}
            {aiLatency && (
              <span
                className="hide-narrow"
                title="Tempo até o primeiro texto / tempo total da resposta"
                style={{ fontSize: '0.68rem', color: '#94a3b8' }}
              >
                Tempo {(aiLatency.firstTokenMs / 1000).toFixed(1)}s
                {isAnswerStreaming ? ' …' : ` / ${(aiLatency.totalMs / 1000).toFixed(1)}s`}
              </span>
            )}
            {indexStatus?.locations?.length > 1 && (
              <select
                aria-label="Fonte local para consulta"
                value={sourceFilter}
                onChange={(event) => {
                  const source = event.target.value
                  setSourceFilter(source)
                  window.api.setKnowledgeSourceFilter(source)
                }}
                style={{
                  background: 'rgba(15,23,42,0.85)',
                  color: '#cbd5e1',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '6px',
                  padding: '3px 6px',
                  fontSize: '0.68rem',
                  maxWidth: '145px'
                }}
              >
                <option value="all">Todas as fontes</option>
                {indexStatus.locations.map((location) => (
                  <option key={location} value={location}>
                    {location.split('/').filter(Boolean).pop()}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={() => window.api.retryLastMeetingQuestion()}
              style={{
                background: 'transparent',
                color: '#67e8f9',
                border: '1px solid rgba(103,232,249,0.3)',
                borderRadius: '6px',
                padding: '3px 7px',
                cursor: 'pointer',
                fontSize: '0.68rem'
              }}
              title="Responder de novo à última pergunta"
            >
              Repetir
            </button>
          </div>
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              fontSize: '0.88rem',
              lineHeight: '1.6',
              color: '#f1f5f9',
              paddingRight: '6px'
            }}
            className="markdown-content"
            ref={answerAreaRef}
          >
            <div ref={answerContentRef} style={{ display: 'flow-root' }}>
              {formData.showManualQuestion && (
                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                  <input
                    aria-label="Pergunta manual"
                    value={manualQuestion}
                    onChange={(event) => setManualQuestion(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') handleManualQuestion()
                    }}
                    placeholder="Pergunte manualmente…"
                    style={{
                      flex: 1,
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: '#f8fafc',
                      borderRadius: '8px',
                      padding: '6px 10px',
                      fontSize: '0.82rem',
                      outline: 'none'
                    }}
                  />
                  <button
                    onClick={handleManualQuestion}
                    disabled={!manualQuestion.trim()}
                    style={{
                      background: '#0891b2',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '8px',
                      padding: '0 12px',
                      fontSize: '0.82rem',
                      cursor: 'pointer',
                      fontWeight: '600'
                    }}
                  >
                    Enviar
                  </button>
                </div>
              )}
              {aiAnswer ? (
                <>
                  {currentQuestion && (
                    <div className="answer-question" title={currentQuestion}>
                      {currentQuestion}
                    </div>
                  )}
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{aiAnswer}</ReactMarkdown>
                  {/* Sources are debugging detail: shown only with the debug option (Prévia) on. */}
                  {formData.showLivePreview && aiSources.length > 0 && (
                    <div
                      style={{
                        marginTop: '14px',
                        paddingTop: '10px',
                        borderTop: '1px solid rgba(255,255,255,0.06)',
                        fontSize: '0.7rem',
                        color: '#94a3b8',
                        lineHeight: '1.5'
                      }}
                    >
                      Base local consultada:{' '}
                      {aiSources.map((source) => source.split('/').pop()).join(' · ')}
                    </div>
                  )}
                </>
              ) : (
                <div
                  style={{
                    padding: '12px 0',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#64748b',
                    fontSize: '0.9rem',
                    textAlign: 'center',
                    lineHeight: '1.6'
                  }}
                >
                  {formData.autoAnswer
                    ? 'Ouvindo o áudio da reunião. As respostas sugeridas aparecerão aqui.'
                    : 'Respostas automáticas desativadas. Você ainda pode fazer uma pergunta manual.'}
                </div>
              )}
              {previousAnswers
                .slice(0, Math.max(0, formData.answerCount - 1))
                .map((previous, index) => (
                  <div
                    key={`${index}-${previous.question}`}
                    className={`previous-answer previous-answer-${index + 1}`}
                  >
                    <div className="previous-answer-label">
                      {index === 0 ? 'Anterior' : 'Antes dela'}
                    </div>
                    {previous.question && (
                      <div className="answer-question" title={previous.question}>
                        {previous.question}
                      </div>
                    )}
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{previous.answer}</ReactMarkdown>
                    {formData.showLivePreview && previous.sources.length > 0 && (
                      <div className="previous-answer-sources">
                        {previous.sources.map((source) => source.split('/').pop()).join(' · ')}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
