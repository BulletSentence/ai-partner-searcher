import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildFinalTranscript } from '../src/main/finalTranscription.js'
import { createMeetingRecorder, listSavedMeetings } from '../src/main/meetingRecorder.js'
import { isLikelyQuestion } from '../src/main/questionDetector.js'
import { isEchoOfOthers, isUsableTranscript } from '../src/main/transcriptFilter.js'

test('records audio and transcript of a meeting into its own folder', async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), 'meeting-copilot-recorder-'))
  t.after(() => rm(baseDir, { recursive: true, force: true }))
  // Without ffmpeg the per-speaker WAV files are the recording.
  const previousFfmpeg = process.env.FFMPEG_PATH
  process.env.FFMPEG_PATH = join(baseDir, 'missing-ffmpeg')
  t.after(() => {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH
    else process.env.FFMPEG_PATH = previousFfmpeg
  })

  const recorder = createMeetingRecorder({
    baseDir,
    meeting: { meetingContext: 'Reunião FIDC Rubicon 2' }
  })
  recorder.writeAudio('others', Buffer.alloc(32_000, 1))
  recorder.writeAudio('me', Buffer.alloc(16_000, 1))
  recorder.addUtterance({
    speaker: 'me',
    text: 'Usamos token Bearer.',
    startMs: 4_000,
    endMs: 6_000
  })
  recorder.addUtterance({
    speaker: 'others',
    text: 'Como funciona a autenticação?',
    startMs: 1_000,
    endMs: 3_000
  })
  const folder = await recorder.finalize({
    diagnostics: [
      {
        question: 'Como funciona a autenticação?',
        answer: 'Com token Bearer.',
        sources: ['auth.md']
      }
    ]
  })

  const files = await readdir(folder)
  assert.deepEqual(files.sort(), [
    'audio-eu.wav',
    'audio-participantes.wav',
    'reuniao.json',
    'transcricao.jsonl',
    'transcricao.md'
  ])
  assert.match(folder, /_reuniao-fidc-rubicon-2$/)

  const othersWav = await readFile(join(folder, 'audio-participantes.wav'))
  const ownerWav = await readFile(join(folder, 'audio-eu.wav'))
  assert.equal(othersWav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(othersWav.readUInt32LE(40), othersWav.length - 44)
  assert.equal(othersWav.length, ownerWav.length, 'both tracks are padded to the same duration')

  const markdown = await readFile(join(folder, 'transcricao.md'), 'utf8')
  assert.ok(
    markdown.indexOf('Participantes:** Como funciona') < markdown.indexOf('Eu:** Usamos token')
  )
  assert.match(markdown, /Com token Bearer\./)

  const [saved] = await listSavedMeetings(baseDir)
  assert.equal(saved.folder, folder)
  assert.equal(saved.data.transcript.length, 2)
  assert.equal(saved.data.meeting.context, 'Reunião FIDC Rubicon 2')
})

test('answers real questions but not small talk', () => {
  assert.equal(
    isLikelyQuestion('Outra dúvida, quando a averbação não reflete, o webhook é reenviado?'),
    true
  )
  assert.equal(isLikelyQuestion('E qual é o prazo para a cessão dos contratos?'), true)
  assert.equal(isLikelyQuestion('Bom dia, tudo bem?'), false)
  assert.equal(isLikelyQuestion('Vocês estão me ouvindo?'), false)
  assert.equal(isLikelyQuestion('A gente fechou o lote ontem, né?'), false)
  assert.equal(isLikelyQuestion('Bom dia, tudo bem? Como funciona a cessão para o fundo?'), true)
})

test('drops Whisper hallucinations and microphone echo of the call', () => {
  assert.equal(isUsableTranscript('Legendas pela comunidade Amara.org'), false)
  assert.equal(isUsableTranscript('Como funciona a API?', { noSpeechProbability: 0.9 }), false)
  assert.equal(isUsableTranscript('Termos usados: Credifit, FIDC, Dataprev.'), false)
  assert.equal(isUsableTranscript('E aí', { confidence: 0.42 }), false)
  assert.equal(isUsableTranscript('E aí', { confidence: 0.67, durationMs: 6_000 }), false)
  assert.equal(isUsableTranscript('Qual o prazo?', { confidence: 0.97 }), true)
  assert.equal(
    isUsableTranscript('Como funciona a API externa?', { noSpeechProbability: 0.01 }),
    true
  )

  const client = [
    { text: 'Como funciona a autenticação na API externa?', startMs: 8_000, endMs: 12_000 }
  ]
  assert.equal(
    isEchoOfOthers(
      { text: 'como funciona a autenticação na API externa', startMs: 8_200, endMs: 12_100 },
      client
    ),
    true
  )
  assert.equal(
    isEchoOfOthers(
      { text: 'A gente usa token Bearer com validade de uma hora.', startMs: 9_000, endMs: 13_000 },
      client
    ),
    false
  )
})

test('builds the final transcript from the segments of each recorded side', () => {
  const transcript = buildFinalTranscript(
    {
      others: [
        { t0: 0, t1: 4_000, text: 'Bom dia, vamos falar do fundo.', p: 0.93, nsp: 0 },
        { t0: 4_500, t1: 9_000, text: 'Como funciona a sessão dos contratos?', p: 0.95, nsp: 0 },
        { t0: 30_000, t1: 38_000, text: '...', p: 0.32, nsp: 0 }
      ],
      me: [
        { t0: 4_700, t1: 9_100, text: 'como funciona a sessão dos contratos', p: 0.9, nsp: 0 },
        { t0: 10_000, t1: 14_000, text: 'A cessão acontece todo dia útil.', p: 0.94, nsp: 0 }
      ]
    },
    { correctText: (text) => text.replace('sessão dos contratos', 'cessão de contratos') }
  )

  assert.deepEqual(
    transcript.map(({ speaker, text }) => [speaker, text]),
    [
      ['others', 'Bom dia, vamos falar do fundo. Como funciona a cessão de contratos?'],
      ['me', 'A cessão acontece todo dia útil.']
    ]
  )
  assert.equal(transcript[0].startMs, 0)
  assert.equal(transcript[0].endMs, 9_000)
})
