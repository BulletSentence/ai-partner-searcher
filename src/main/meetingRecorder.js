import { execFile } from 'child_process'
import fs from 'fs'
import { join } from 'path'

const SAMPLE_RATE = 16_000
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000
const WAV_HEADER_BYTES = 44
const SPEAKERS = {
  client: { label: 'Cliente', file: 'audio-cliente.wav' },
  me: { label: 'Eu', file: 'audio-eu.wav' },
  manual: { label: 'Pergunta manual' },
  screen: { label: 'Tela' }
}

/** Human label for a speaker id, shared by the live view and the saved transcript. */
export function speakerLabel(speaker) {
  return SPEAKERS[speaker]?.label || 'Participante'
}

function wavHeader(dataBytes) {
  const header = Buffer.alloc(WAV_HEADER_BYTES)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return header
}

export function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const part = (value) => String(value).padStart(2, '0')
  return `${part(Math.floor(totalSeconds / 3600))}:${part(Math.floor((totalSeconds % 3600) / 60))}:${part(totalSeconds % 60)}`
}

function folderName(startedAt, context) {
  const part = (value) => String(value).padStart(2, '0')
  const stamp = `${startedAt.getFullYear()}-${part(startedAt.getMonth() + 1)}-${part(startedAt.getDate())}_${part(startedAt.getHours())}-${part(startedAt.getMinutes())}-${part(startedAt.getSeconds())}`
  const slug = (context || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase()
  return slug ? `${stamp}_${slug}` : stamp
}

/** Runs ffmpeg and resolves with whether it succeeded. */
export function runFfmpeg(args) {
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin']
  const env = { ...process.env, PATH: [process.env.PATH, ...extraPaths].filter(Boolean).join(':') }
  return new Promise((resolve) => {
    execFile(process.env.FFMPEG_PATH || 'ffmpeg', args, { env }, (error) => resolve(!error))
  })
}

/**
 * Records one meeting into its own folder: the audio of each side, the transcript as it is spoken,
 * and a summary file when the meeting ends. Everything is written as it happens, so an app crash
 * loses at most the final summary, never the recording or the transcript.
 */
export function createMeetingRecorder({ baseDir, meeting = {}, startedAt = new Date() } = {}) {
  const dir = join(baseDir, folderName(startedAt, meeting.meetingContext))
  fs.mkdirSync(dir, { recursive: true })
  const transcriptLogPath = join(dir, 'transcricao.jsonl')
  const tracks = {}
  const transcript = []
  let finalized = false

  function openTrack(speaker, offsetMs) {
    const path = join(dir, SPEAKERS[speaker].file)
    const fd = fs.openSync(path, 'w')
    fs.writeSync(fd, wavHeader(0))
    const track = { path, fd, dataBytes: 0, offsetMs }
    tracks[speaker] = track
    // Leading silence keeps both tracks aligned with the start of the meeting.
    writeSilence(track, Math.round(offsetMs * BYTES_PER_MS))
    return track
  }

  function writeSilence(track, bytes) {
    const evenBytes = bytes - (bytes % 2)
    const block = Buffer.alloc(Math.min(evenBytes, 1 << 20))
    for (let remaining = evenBytes; remaining > 0; remaining -= block.length) {
      const size = Math.min(remaining, block.length)
      fs.writeSync(track.fd, block, 0, size)
      track.dataBytes += size
    }
  }

  return {
    dir,
    startedAt,

    /** Appends PCM for one speaker and returns when that speaker's track began, in meeting time. */
    writeAudio(speaker, chunk) {
      if (finalized || !SPEAKERS[speaker]?.file) return 0
      let track = tracks[speaker]
      if (!track) {
        const chunkMs = chunk.length / BYTES_PER_MS
        track = openTrack(speaker, Math.max(0, Date.now() - startedAt.getTime() - chunkMs))
      }
      fs.writeSync(track.fd, chunk)
      track.dataBytes += chunk.length
      return track.offsetMs
    },

    /** Meeting time at which a speaker's audio track started (0 before any audio arrived). */
    trackOffsetMs(speaker) {
      return tracks[speaker]?.offsetMs || 0
    },

    /** Saves one spoken utterance immediately. */
    addUtterance({ speaker, text, startMs, endMs }) {
      const entry = {
        speaker,
        text,
        startMs: Math.round(startMs),
        endMs: Math.round(endMs ?? startMs)
      }
      transcript.push(entry)
      if (!finalized) fs.appendFileSync(transcriptLogPath, `${JSON.stringify(entry)}\n`)
      return entry
    },

    getTranscript() {
      return [...transcript].sort((first, second) => first.startMs - second.startMs)
    },

    /** Closes the audio, writes the readable transcript and the meeting summary. */
    async finalize({ conversationHistory = [], diagnostics = [] } = {}) {
      if (finalized) return dir
      finalized = true
      const endedAt = new Date()
      const openTracks = Object.entries(tracks)
      const longest = Math.max(0, ...openTracks.map(([, track]) => track.dataBytes))
      for (const [, track] of openTracks) {
        writeSilence(track, longest - track.dataBytes)
        fs.writeSync(track.fd, wavHeader(track.dataBytes), 0, WAV_HEADER_BYTES, 0)
        fs.closeSync(track.fd)
      }

      let audioFiles = openTracks.map(([speaker, track]) => ({
        file: SPEAKERS[speaker].file,
        description: speakerLabel(speaker),
        path: track.path
      }))
      if (audioFiles.length) {
        const output = join(dir, 'audio.m4a')
        const inputs = audioFiles.flatMap(({ path }) => ['-i', path])
        const mix =
          audioFiles.length === 2
            ? ['-filter_complex', '[0:a][1:a]amerge=inputs=2[a]', '-map', '[a]', '-ac', '2']
            : ['-ac', '1']
        const converted = await runFfmpeg([
          '-y',
          '-loglevel',
          'error',
          ...inputs,
          ...mix,
          '-c:a',
          'aac',
          '-b:a',
          '64k',
          output
        ])
        if (converted && fs.existsSync(output) && fs.statSync(output).size > 0) {
          const description =
            audioFiles.length === 2
              ? 'canal esquerdo: cliente; canal direito: você'
              : audioFiles[0].description
          audioFiles.forEach(({ path }) => fs.rmSync(path, { force: true }))
          audioFiles = [
            { file: 'audio.m4a', description, speakers: openTracks.map(([speaker]) => speaker) }
          ]
        }
      }
      const audio = audioFiles.map(({ file, description, speakers }) => ({
        file,
        description,
        ...(speakers ? { speakers } : {})
      }))

      const ordered = this.getTranscript()
      const durationMs = Math.max(longest / BYTES_PER_MS, endedAt.getTime() - startedAt.getTime())
      const lines = [
        `# Reunião — ${meeting.meetingContext || 'sem contexto'}`,
        '',
        `- Data: ${startedAt.toLocaleString('pt-BR')}`,
        `- Duração: ${formatClock(durationMs)}`,
        ...audio.map(({ file, description }) => `- Áudio: [${file}](${file}) (${description})`),
        '',
        '## Transcrição',
        '',
        ...(ordered.length
          ? ordered.map(
              ({ speaker, text, startMs }) =>
                `**[${formatClock(startMs)}] ${speakerLabel(speaker)}:** ${text}\n`
            )
          : ['_Nenhuma fala foi transcrita._', ''])
      ]
      const answered = diagnostics.filter((item) => item.question && item.answer)
      if (answered.length) {
        lines.push('## Perguntas respondidas pelo copiloto', '')
        for (const item of answered) {
          lines.push(`### ${item.question}`, '', item.answer, '')
          if (item.sources?.length)
            lines.push(`Fontes: ${[...new Set(item.sources)].join(', ')}`, '')
        }
      }
      fs.writeFileSync(join(dir, 'transcricao.md'), lines.join('\n'))

      const session = {
        timestamp: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: Math.round(durationMs),
        meeting: {
          context: meeting.meetingContext || 'N/A',
          projectPaths: meeting.projectPaths || 'N/A',
          obsidianVaultPath: meeting.obsidianVaultPath || 'N/A',
          language: meeting.language || 'pt-BR',
          transcriberModel: meeting.transcriberModel || ''
        },
        audio,
        transcript: ordered,
        conversationHistory,
        diagnostics
      }
      fs.writeFileSync(join(dir, 'reuniao.json'), JSON.stringify(session, null, 2))
      return dir
    }
  }
}

/** Lists saved meetings, newest first: one folder per meeting plus the older single-file format. */
export async function listSavedMeetings(baseDir) {
  let entries
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const sessions = []
  for (const entry of entries) {
    const path = entry.isDirectory()
      ? join(baseDir, entry.name, 'reuniao.json')
      : entry.name.endsWith('.json')
        ? join(baseDir, entry.name)
        : null
    if (!path) continue
    try {
      const data = JSON.parse(await fs.promises.readFile(path, 'utf8'))
      sessions.push({
        filename: entry.name,
        folder: entry.isDirectory() ? join(baseDir, entry.name) : null,
        data
      })
    } catch (error) {
      // A meeting that ended abruptly has audio and transcript but no summary file yet.
      if (error.code !== 'ENOENT')
        console.warn(`[Meetings] Could not read ${path}: ${error.message}`)
    }
  }
  return sessions.sort((first, second) =>
    String(second.data.timestamp || '').localeCompare(String(first.data.timestamp || ''))
  )
}
