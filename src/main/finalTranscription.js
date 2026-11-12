import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { formatClock, runFfmpeg, speakerLabel } from './meetingRecorder.js'
import { isEchoOfClient, isUsableTranscript } from './transcriptFilter.js'

const TRACK_FILES = { client: 'audio-cliente.wav', me: 'audio-eu.wav' }
const PARAGRAPH_GAP_MS = 2_000
const PARAGRAPH_MAX_CHARS = 700
export const FINAL_TRANSCRIPT_FILE = 'transcricao-final.md'

function readMeetingSummary(folder) {
  try {
    return JSON.parse(fs.readFileSync(join(folder, 'reuniao.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Finds which audio of a saved meeting belongs to each speaker. */
export function locateRecordingTracks(folder) {
  const wavTracks = Object.entries(TRACK_FILES)
    .filter(([, file]) => fs.existsSync(join(folder, file)))
    .map(([speaker, file]) => ({ speaker, file, channel: null }))
  if (wavTracks.length) return wavTracks

  if (!fs.existsSync(join(folder, 'audio.m4a'))) return []
  const speakers = readMeetingSummary(folder)?.audio?.[0]?.speakers || ['client', 'me']
  return speakers.map((speaker, index) => ({
    speaker,
    file: 'audio.m4a',
    channel: speakers.length > 1 ? index : null
  }))
}

/** Returns a file the adapter can read for one speaker, decoding the compressed recording if needed. */
async function prepareTrack(folder, track, workDir) {
  const source = join(folder, track.file)
  if (track.file.endsWith('.wav')) return source
  const output = join(workDir, `${track.speaker}.raw`)
  const filter = track.channel === null ? [] : ['-af', `pan=mono|c0=c${track.channel}`]
  const args = ['-y', '-loglevel', 'error', '-i', source, ...filter, '-ac', '1', '-ar', '16000']
  const converted = await runFfmpeg([...args, '-f', 's16le', output])
  return converted && fs.existsSync(output) ? output : null
}

/** Runs the adapter's offline mode over one track and resolves with its timed segments. */
function runOfflinePass({
  binary,
  modelPath,
  vadModelPath,
  language,
  prompt,
  file,
  onProgress,
  signal
}) {
  return new Promise((resolve, reject) => {
    const args = [
      '--model',
      modelPath,
      '--language',
      language === 'en-US' ? 'en' : 'pt',
      '--file',
      file
    ]
    if (prompt) args.push('--prompt', prompt)
    if (vadModelPath) args.push('--vad-model', vadModelPath)
    if (process.env.WHISPER_FINAL_BEAM_SIZE)
      args.push('--beam', process.env.WHISPER_FINAL_BEAM_SIZE)
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    const segments = []
    let buffer = ''
    let finished = false
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })

    child.stdout.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines.filter(Boolean)) {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.type === 'segment') segments.push(message)
        else if (message.type === 'progress' && message.total > 0)
          onProgress?.(message.done / message.total)
        else if (message.type === 'done') finished = true
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new Error('cancelled'))
      else if (code !== 0 || !finished) reject(new Error(`Whisper terminou com código ${code}`))
      else resolve(segments)
    })
  })
}

/**
 * Turns the raw segments of each speaker into the documented transcript: invented text and
 * microphone echo removed, both sides interleaved by time, and each speaker's consecutive
 * sentences joined into paragraphs.
 */
export function buildFinalTranscript(
  segmentsBySpeaker,
  { prompt = '', correctText = (text) => text } = {}
) {
  const entries = []
  for (const [speaker, segments] of Object.entries(segmentsBySpeaker)) {
    for (const segment of segments) {
      const text = correctText(segment.text)
      const usable = isUsableTranscript(text, {
        noSpeechProbability: segment.nsp,
        confidence: typeof segment.p === 'number' ? segment.p : 1,
        // Pauses inside a block are not speech time.
        durationMs: segment.voiced ?? segment.t1 - segment.t0,
        prompt
      })
      if (usable) entries.push({ speaker, text, startMs: segment.t0, endMs: segment.t1 })
    }
  }
  const clientEntries = entries.filter((entry) => entry.speaker === 'client')
  const ordered = entries
    .filter((entry) => entry.speaker !== 'me' || !isEchoOfClient(entry, clientEntries))
    .sort((first, second) => first.startMs - second.startMs)

  const paragraphs = []
  for (const entry of ordered) {
    const last = paragraphs.at(-1)
    const continues =
      last &&
      last.speaker === entry.speaker &&
      entry.startMs - last.endMs <= PARAGRAPH_GAP_MS &&
      last.text.length + entry.text.length <= PARAGRAPH_MAX_CHARS
    if (continues) {
      last.text = `${last.text} ${entry.text}`
      last.endMs = entry.endMs
    } else {
      paragraphs.push({ ...entry })
    }
  }
  return paragraphs
}

function formatFinalTranscript({ summary, transcript, modelLabel, durationMs }) {
  const startedAt = summary?.timestamp ? new Date(summary.timestamp).toLocaleString('pt-BR') : null
  const lines = [
    `# Transcrição final — ${summary?.meeting?.context || 'reunião'}`,
    '',
    ...(startedAt ? [`- Data: ${startedAt}`] : []),
    `- Duração: ${formatClock(durationMs)}`,
    `- Gerada a partir da gravação, depois da reunião, com o modelo ${modelLabel}`,
    '',
    '## Transcrição',
    '',
    ...(transcript.length
      ? transcript.map(
          ({ speaker, text, startMs }) =>
            `**[${formatClock(startMs)}] ${speakerLabel(speaker)}:** ${text}\n`
        )
      : ['_Nenhuma fala foi encontrada na gravação._', ''])
  ]
  const answered = (summary?.diagnostics || []).filter((item) => item.question && item.answer)
  if (answered.length) {
    lines.push('## Perguntas respondidas pelo copiloto', '')
    for (const item of answered) {
      lines.push(`### ${item.question}`, '', item.answer, '')
      if (item.sources?.length) lines.push(`Fontes: ${[...new Set(item.sources)].join(', ')}`, '')
    }
  }
  return lines.join('\n')
}

/**
 * Transcribes a saved meeting again from its recording, without the time pressure of the live
 * view, and writes `transcricao-final.md` beside it. The live transcript is left untouched.
 */
export async function transcribeRecording({
  folder,
  binary,
  modelPath,
  modelLabel = '',
  vadModelPath = null,
  language = 'pt-BR',
  prompt = '',
  correctText,
  onProgress,
  signal
}) {
  const tracks = locateRecordingTracks(folder)
  if (!tracks.length) throw new Error('A reunião não tem gravação de áudio.')
  const workDir = fs.mkdtempSync(join(os.tmpdir(), 'meeting-final-'))
  try {
    const segmentsBySpeaker = {}
    let durationMs = 0
    for (const [index, track] of tracks.entries()) {
      const file = await prepareTrack(folder, track, workDir)
      if (!file) throw new Error('Não foi possível ler a gravação (o ffmpeg está instalado?).')
      const segments = await runOfflinePass({
        binary,
        modelPath,
        vadModelPath,
        language,
        prompt,
        file,
        signal,
        onProgress: (fraction) => onProgress?.((index + fraction) / tracks.length)
      })
      segmentsBySpeaker[track.speaker] = segments
      durationMs = Math.max(durationMs, ...segments.map((segment) => segment.t1))
    }

    const transcript = buildFinalTranscript(segmentsBySpeaker, { prompt, correctText })
    const summary = readMeetingSummary(folder)
    durationMs = summary?.durationMs || durationMs
    fs.writeFileSync(
      join(folder, FINAL_TRANSCRIPT_FILE),
      formatFinalTranscript({ summary, transcript, modelLabel, durationMs })
    )
    if (summary) {
      summary.finalTranscript = transcript
      summary.finalTranscriptModel = modelLabel
      summary.finalTranscriptAt = new Date().toISOString()
      fs.writeFileSync(join(folder, 'reuniao.json'), JSON.stringify(summary, null, 2))
    }
    return transcript
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}
