import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function App() {
  const [isSetupComplete, setIsSetupComplete] = useState(false)

  // Form State
  const [formData, setFormData] = useState({
    meetingContext: '',
    projectPaths: '',
    obsidianVaultPath: '',
    audioOutputDevice: '',
    transcriberModel: '',
    language: 'pt-BR',
    useOllama: false,
    openaiModel: 'gpt-6-luna'
  })

  // History Log States
  const [savedSessions, setSavedSessions] = useState([])
  const [selectedSession, setSelectedSession] = useState(null)
  const [indexStatus, setIndexStatus] = useState(null)
  const [isPreparingSources, setIsPreparingSources] = useState(false)
  const [audioOutputs, setAudioOutputs] = useState([])
  const [transcriptionModels, setTranscriptionModels] = useState([])

  // HUD State
  const [transcription, setTranscription] = useState('')
  const [transcriptionHistory, setTranscriptionHistory] = useState([])
  const [aiAnswer, setAiAnswer] = useState('')
  const [aiProvider, setAiProvider] = useState('')
  const [aiSources, setAiSources] = useState([])
  const [aiLatency, setAiLatency] = useState(null)
  const [isAnswerStreaming, setIsAnswerStreaming] = useState(false)
  const [answerStatus, setAnswerStatus] = useState('Ouvindo')
  const [manualQuestion, setManualQuestion] = useState('')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [hasLoadedSettings, setHasLoadedSettings] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [audioSource, setAudioSource] = useState('SYSTEM')
  const [isClickThrough, setIsClickThrough] = useState(false)
  const transcriptEndRef = useRef(null)
  const nativeAudioCleanupRef = useRef(null)

  const stopNativeAudioCapture = async () => {
    const cleanup = nativeAudioCleanupRef.current
    nativeAudioCleanupRef.current = null
    if (cleanup) await cleanup()
  }

  const startNativeAudioCapture = async () => {
    if (!window.api.isMac || nativeAudioCleanupRef.current) return

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

      const audioContext = new AudioContext({ sampleRate: 16000 })
      const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]))
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      const silentGain = audioContext.createGain()
      silentGain.gain.value = 0

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        const pcm = new Int16Array(input.length)
        for (let index = 0; index < input.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, input[index]))
          pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
        }
        window.api.sendNativeAudioChunk(pcm.buffer)
      }

      source.connect(processor)
      processor.connect(silentGain)
      silentGain.connect(audioContext.destination)

      nativeAudioCleanupRef.current = async () => {
        processor.disconnect()
        source.disconnect()
        silentGain.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        await audioContext.close()
      }
    } catch (error) {
      window.api.reportNativeAudioError(error.message)
      throw error
    }
  }

  // Load saved sessions when returning to the setup screen
  const loadSavedSessions = async () => {
    try {
      const sessions = await window.api.getSavedMeetings()
      setSavedSessions(sessions)
    } catch (err) {
      console.error('Error loading saved sessions:', err)
    }
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
      .then(([profile, settings]) => setFormData((current) => ({ ...current, ...profile, ...settings })))
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
    window.api
      .getTranscriptionModels()
      .then((models) => {
        const availableModels = Array.isArray(models) ? models : []
        setTranscriptionModels(availableModels)
        setFormData((current) => {
          const selectedModelIsAvailable = availableModels.some(
            (model) => model.id === current.transcriberModel
          )
          return selectedModelIsAvailable || availableModels.length !== 1
            ? current
            : { ...current, transcriberModel: availableModels[0].id }
        })
      })
      .catch((err) => console.error('Error loading transcription models:', err))
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
    window.api.onTranscription((text) => {
      setTranscription(text)
      setTranscriptionHistory((prev) => [...prev, text])
    })

    // Listen for AI assistant updates
    window.api.onAiAnswerStart((data) => {
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
        setAiAnswer(data.answer)
        setAiProvider(data.provider)
        setAiSources(Array.isArray(data.sources) ? data.sources : [])
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
    if (!formData.transcriberModel || transcriptionModels.length === 0) return
    setIsPreparingSources(true)
    try {
      if (window.api.isMac) await startNativeAudioCapture()
      const status = await window.api.prepareKnowledgeSources(formData)
      setIndexStatus(status)
      setSourceFilter('all')
      window.api.startMeeting(formData)
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

  const handleStop = () => {
    window.api.stopMeeting()
    setTranscription('')
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
    padding: '10px 14px',
    fontSize: '0.9rem',
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
          width: 'min(860px, 100%)',
          maxWidth: '860px',
          height: '600px',
          display: 'flex',
          flexDirection: 'column',
          background: 'rgba(15, 15, 20, 0.95)',
          backdropFilter: 'blur(30px)',
          borderRadius: '28px',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          color: '#ffffff',
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
          padding: '24px 30px 20px 30px',
          boxSizing: 'border-box',
          justifyContent: 'space-between',
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
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: '30px',
            margin: '-12px -18px 10px',
            padding: '0 12px',
            background: 'rgba(30, 41, 59, 0.98)',
            borderBottom: '2px solid #22d3ee',
            WebkitAppRegion: 'drag',
            userSelect: 'none'
          }}
        >
          <span style={{ fontSize: '0.72rem', color: '#22d3ee', fontWeight: '600' }}>
            🛸 Copilot de reuniões com IA
          </span>
          <div style={{ display: 'flex', gap: '6px', WebkitAppRegion: 'no-drag' }}>
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

        {/* Drawer overlay for inspecting a past session */}
        {selectedSession && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(10, 10, 15, 0.98)',
              borderRadius: '28px',
              padding: '30px',
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
                  📂 Histórico da reunião: {selectedSession.data.meeting?.context || 'Sem contexto'}
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
                  🎙️ Histórico completo da transcrição
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {selectedSession.data.conversationHistory
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
                  🧠 Sugestões geradas pela IA
                </h4>
                {selectedSession.data.conversationHistory
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

        {/* Config Form Fields */}
        <div>
          <h2
            style={{
              margin: '0 0 4px 0',
              fontSize: '1.6rem',
              color: '#22d3ee',
              fontWeight: '700',
              letterSpacing: '0.5px'
            }}
          >
            🛸 Configuração do Copilot
          </h2>
          <p style={{ margin: '0 0 20px 0', fontSize: '0.9rem', color: '#64748b' }}>
            Prepare o contexto, os projetos e o vault antes de entrar na reunião.
          </p>

          <div className="setup-form-columns" style={{ display: 'flex', gap: '30px' }}>
            {/* Left Form Column */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                  Contexto da reunião
                </label>
                <textarea
                  value={formData.meetingContext}
                  onChange={(e) => setFormData({ ...formData, meetingContext: e.target.value })}
                  placeholder="Cliente, objetivo, pauta, produtos e pontos importantes..."
                  style={{ ...inputStyle, height: '88px', resize: 'none' }}
                  onFocus={(e) => (e.target.style.borderColor = 'rgba(34, 211, 238, 0.5)')}
                  onBlur={(e) => (e.target.style.borderColor = 'rgba(255, 255, 255, 0.08)')}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                  Projetos para consultar
                </label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={formData.projectPaths}
                    readOnly
                    placeholder="Nenhuma pasta selecionada (opcional)"
                    title={formData.projectPaths || 'Nenhuma pasta selecionada'}
                    style={{ ...inputStyle, flex: 1, cursor: 'default' }}
                  />
                  <button type="button" onClick={selectProjectFolders} style={folderButtonStyle}>
                    Buscar pastas
                  </button>
                  <button
                    type="button"
                    onClick={clearProjectFolders}
                    disabled={!formData.projectPaths}
                    style={{ ...folderButtonStyle, color: '#94a3b8', cursor: formData.projectPaths ? 'pointer' : 'default' }}
                  >
                    Limpar
                  </button>
                </div>
                <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                  Selecione 0, 1 ou 2 pastas de projeto.
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                  Vault do Obsidian
                </label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={formData.obsidianVaultPath}
                    readOnly
                    placeholder="Nenhuma pasta selecionada (opcional)"
                    title={formData.obsidianVaultPath || 'Nenhuma pasta selecionada'}
                    style={{ ...inputStyle, flex: 1, cursor: 'default' }}
                  />
                  <button type="button" onClick={selectObsidianFolder} style={folderButtonStyle}>
                    Buscar pasta
                  </button>
                  <button
                    type="button"
                    onClick={clearObsidianFolder}
                    disabled={!formData.obsidianVaultPath}
                    style={{ ...folderButtonStyle, color: '#94a3b8', cursor: formData.obsidianVaultPath ? 'pointer' : 'default' }}
                  >
                    Limpar
                  </button>
                </div>
                <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                  Selecione uma pasta do vault do Obsidian.
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                  Saída de áudio para ouvir
                </label>
                <select
                  value={formData.audioOutputDevice}
                  onChange={(e) => setFormData({ ...formData, audioOutputDevice: e.target.value })}
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
                    {transcriptionModels.length ? 'Selecione um modelo' : 'Nenhum modelo encontrado'}
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
                    ? 'Modelo local usado para transformar áudio em texto.'
                    : 'Nenhuma pasta Vosk válida foi encontrada na raiz do projeto.'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
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
                    Modelo OpenAI
                  </label>
                  <select
                    value={formData.openaiModel}
                    onChange={(e) => setFormData({ ...formData, openaiModel: e.target.value })}
                    style={inputStyle}
                  >
                    <option value="gpt-6-luna">GPT-6 Luna</option>
                    <option value="gpt-4o-mini">GPT-4o Mini</option>
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                <input
                  type="checkbox"
                  id="useOllama"
                  checked={formData.useOllama || false}
                  onChange={(e) => setFormData({ ...formData, useOllama: e.target.checked })}
                  style={{
                    cursor: 'pointer',
                    width: '16px',
                    height: '16px',
                    accentColor: '#22d3ee'
                  }}
                />
                <label
                  htmlFor="useOllama"
                  className="text-content"
                  style={{
                    fontSize: '0.85rem',
                    color: '#cbd5e1',
                    fontWeight: '600',
                    cursor: 'pointer'
                  }}
                >
                  Usar modelo local do Ollama (gemma2:2b / offline)
                </label>
              </div>
            </div>

            {/* Right Form Column */}
            <div style={{ flex: 1.2, display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                  Como serão usadas as fontes locais
                </label>
                <textarea
                  value="Na próxima rajada, o app vai ler localmente os projetos e o vault indicados acima para encontrar respostas rápidas, mesmo se o MCP do Obsidian não responder."
                  readOnly
                  style={{ ...inputStyle, height: '70px', resize: 'none' }}
                  onFocus={(e) => (e.target.style.borderColor = 'rgba(34, 211, 238, 0.5)')}
                  onBlur={(e) => (e.target.style.borderColor = 'rgba(255, 255, 255, 0.08)')}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: '600' }}>
                  Privacidade
                </label>
                <textarea
                  value="A transcrição é local. Quando você usar um provedor de IA em nuvem, a pergunta e o contexto necessário para respondê-la poderão ser enviados ao provedor."
                  readOnly
                  style={{ ...inputStyle, height: '70px', resize: 'none' }}
                  onFocus={(e) => (e.target.style.borderColor = 'rgba(34, 211, 238, 0.5)')}
                  onBlur={(e) => (e.target.style.borderColor = 'rgba(255, 255, 255, 0.08)')}
                />
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
                  Índice local: {indexStatus.files} arquivo(s), {indexStatus.chunks} trecho(s).
                  {indexStatus.errors?.length ? ` ${indexStatus.errors[0]}` : ''}
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
            📂 Histórico de sessões salvas
          </h4>
          <div
            style={{
              display: 'flex',
              gap: '12px',
              overflowX: 'auto',
              paddingBottom: '4px'
            }}
          >
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
                  onClick={() => setSelectedSession(session)}
                  style={{
                    flexShrink: 0,
                    width: '230px',
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
                  <div
                    className="session-card-details"
                    style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '2px' }}
                  >
                    {session.data.meeting?.obsidianVaultPath || 'Sem vault configurado'}
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
            disabled={isPreparingSources || transcriptionModels.length === 0 || !formData.transcriberModel}
            style={{
              background: 'linear-gradient(135deg, #06b6d4 0%, #0891b2 100%)',
              border: 'none',
              color: '#ffffff',
              padding: '10px 28px',
              borderRadius: '12px',
              fontSize: '0.95rem',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(6, 182, 212, 0.35)',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => (e.target.style.boxShadow = '0 6px 20px rgba(6, 182, 212, 0.5)')}
            onMouseLeave={(e) => (e.target.style.boxShadow = '0 4px 14px rgba(6, 182, 212, 0.35)')}
          >
            {isPreparingSources
              ? 'Preparando fontes locais…'
              : transcriptionModels.length === 0
                ? 'Modelo de transcrição ausente'
                : '🚀 Iniciar reunião'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="app-shell hud-shell"
      style={{
        width: 'min(860px, 100%)',
        maxWidth: '860px',
        height: '600px',
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(15, 15, 20, 0.82)',
        backdropFilter: 'blur(25px)',
        borderRadius: '28px',
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
          font-family: monospace !important;
          font-size: 0.85rem !important;
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
          padding: '0 20px',
          height: '32px',
          background: 'rgba(30, 41, 59, 0.98)',
          borderBottom: '2px solid #22d3ee',
          WebkitAppRegion: 'drag',
          userSelect: 'none',
          boxSizing: 'border-box',
          boxShadow: '0 4px 20px rgba(34, 211, 238, 0.15)',
          transition: 'all 0.3s ease'
        }}
      >
        <span
          className="hud-topbar-title"
          style={{ fontSize: '0.75rem', color: '#22d3ee', fontWeight: '600' }}
        >
          🛸 Copilot de reuniões com IA
        </span>
        <div
          className="hud-window-controls"
          style={{ display: 'flex', alignItems: 'center', gap: '12px', WebkitAppRegion: 'no-drag' }}
        >
          <button
            type="button"
            onClick={toggleClickThrough}
            className="window-control-btn"
            title={isClickThrough ? 'Ativar cliques na janela' : 'Deixar cliques passarem para trás'}
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
            {isClickThrough ? 'Interagir' : 'Click-through'}
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
              marginRight: '8px',
              fontSize: '0.75rem',
              fontWeight: '600',
              cursor: 'pointer',
              transition: 'all 0.2s',
              WebkitAppRegion: 'no-drag'
            }}
            onMouseEnter={(e) => {
              e.target.style.background = 'rgba(239, 68, 68, 0.25)'
              e.target.style.transform = 'scale(1.03)'
            }}
            onMouseLeave={(e) => {
              e.target.style.background = 'rgba(239, 68, 68, 0.12)'
              e.target.style.transform = 'scale(1.0)'
            }}
          >
            ⏹ Encerrar reunião
          </span>
          <button
            onClick={() => window.api.minimize()}
            className="window-control-btn"
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
            [ ─ ]
          </button>
          <button
            onClick={() => window.api.maximize()}
            className="window-control-btn"
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
            [ ▢ ]
          </button>
          <button
            onClick={() => window.api.close()}
            className="window-control-btn"
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
            [ ✕ ]
          </button>
        </div>
      </div>

      {/* Main HUD Dashboard */}
      <div
        className="hud-dashboard"
        style={{
          flex: 1,
          display: 'flex',
          gap: '20px',
          padding: '24px',
          overflow: 'hidden',
          boxSizing: 'border-box'
        }}
      >
        {/* Left Column: Live Audio Transcription History */}
        <div
          className="hud-panel"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(255, 255, 255, 0.02)',
            borderRadius: '18px',
            padding: '20px',
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
              <span style={{ fontSize: '1.2rem' }}>🎙️</span>
              <h3
                style={{
                  margin: 0,
                  fontSize: '1.1rem',
                  color: '#cbd5e1',
                  fontWeight: '600',
                  letterSpacing: '0.5px'
                }}
              >
                Transcrição ao vivo
              </h3>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {/* Audio Visualizer Badge */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background:
                    audioSource === 'MIC' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 211, 238, 0.15)',
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
                  boxShadow: audioSource === 'MIC' ? '0 4px 12px rgba(239, 68, 68, 0.35)' : 'none',
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
                <span>🎙️</span>
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
            {transcriptionHistory.map((text, index) => (
              <div key={index} style={{ fontSize: '0.95rem', color: '#94a3b8', lineHeight: '1.5' }}>
                {text}
              </div>
            ))}
            {transcription && (
              <div
                style={{
                  fontSize: '1.05rem',
                  color: '#4ade80',
                  fontWeight: '600',
                  lineHeight: '1.5'
                }}
              >
                {transcription}...
              </div>
            )}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Right Column: AI Copilot Assistant Suggestions */}
        <div
          className="hud-panel"
          style={{
            flex: 1.4,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(34, 211, 238, 0.02)',
            borderRadius: '18px',
            padding: '20px',
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
              <span style={{ fontSize: '1.2rem' }}>🧠</span>
              <div>
                <h3
                  style={{
                    margin: 0,
                    fontSize: '1.1rem',
                    color: '#22d3ee',
                    fontWeight: '600',
                    letterSpacing: '0.5px'
                  }}
                >
                  Resposta sugerida
                </h3>
                {indexStatus && (
                  <div
                    style={{
                      fontSize: '0.66rem',
                      color: indexStatus.errors?.length ? '#fbbf24' : '#86efac',
                      marginTop: '2px'
                    }}
                  >
                    Base local: {indexStatus.files} arquivos · {indexStatus.chunks} trechos
                  </div>
                )}
                <div style={{ fontSize: '0.66rem', color: '#94a3b8', marginTop: '2px' }}>
                  {answerStatus}
                </div>
              </div>
            </div>
            {aiProvider && (
              <span
                style={{
                  fontSize: '0.75rem',
                  color: '#64748b',
                  background: 'rgba(34, 211, 238, 0.08)',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  border: '1px solid rgba(34, 211, 238, 0.15)',
                  fontWeight: '500'
                }}
              >
                Fornecido por {aiProvider}
              </span>
            )}
            {aiLatency && (
              <span style={{ fontSize: '0.68rem', color: '#94a3b8' }}>
                1º texto: {(aiLatency.firstTokenMs / 1000).toFixed(1)}s ·{' '}
                {isAnswerStreaming
                  ? 'gerando…'
                  : `total: ${(aiLatency.totalMs / 1000).toFixed(1)}s`}
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
            >
              Tentar novamente
            </button>
          </div>
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              fontSize: '0.95rem',
              lineHeight: '1.6',
              color: '#f1f5f9',
              paddingRight: '6px'
            }}
            className="markdown-content"
          >
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
                  padding: '8px 10px',
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
                  cursor: 'pointer',
                  fontWeight: '600'
                }}
              >
                Enviar
              </button>
            </div>
            {aiAnswer ? (
              <>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{aiAnswer}</ReactMarkdown>
                {aiSources.length > 0 && (
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
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#64748b',
                  fontSize: '0.9rem',
                  textAlign: 'center',
                  lineHeight: '1.6'
                }}
              >
                Ouvindo o áudio da reunião...
                <br />
                As respostas sugeridas aparecerão aqui.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
