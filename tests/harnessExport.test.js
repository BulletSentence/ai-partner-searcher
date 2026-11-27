import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportFinalTranscript, meetingDateLabel } from '../src/main/harnessExport.js'

// 27/11/2026 09:05 in the machine's own time zone, the one the file name is written in.
const recordedAt = new Date(2026, 10, 27, 9, 5)

async function makeMeeting(root, name, context, date) {
  const folder = join(root, 'meetings', name)
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'reuniao.json'),
    JSON.stringify({ timestamp: date.toISOString(), meeting: { context }, finalTranscript: [] })
  )
  await writeFile(join(folder, 'transcricao-final.md'), `# ${context}\nTranscrição final`)
  return folder
}

test('the file name starts with the date and time the meeting was recorded', () => {
  assert.equal(meetingDateLabel(recordedAt), '2026-11-27 09h05')
  assert.equal(meetingDateLabel(recordedAt.toISOString()), '2026-11-27 09h05')
  assert.equal(meetingDateLabel('não é data'), '')
  assert.equal(meetingDateLabel(undefined), '')
})

test('exports only the final Markdown into HARNESS and preserves duplicate names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-export-'))
  try {
    const meetingsDirectory = join(root, 'meetings')
    const folder = await makeMeeting(root, 'daily', 'Daily / equipe', recordedAt)
    const destination = join(root, 'vault')
    await mkdir(join(destination, 'HARNESS'), { recursive: true })
    const args = { meetingsDirectory, folder, destination }
    const first = await exportFinalTranscript(args)
    const second = await exportFinalTranscript(args)
    assert.equal(
      first,
      join(destination, 'HARNESS', '2026-11-27 09h05 - Daily - equipe - transcricao final.md')
    )
    // Sending the same meeting again keeps its date and adds a number.
    assert.equal(
      second,
      join(destination, 'HARNESS', '2026-11-27 09h05 - Daily - equipe - transcricao final (2).md')
    )
    assert.equal(await readFile(first, 'utf8'), '# Daily / equipe\nTranscrição final')
    const recorded = JSON.parse(await readFile(join(folder, 'reuniao.json'), 'utf8'))
    assert.deepEqual(
      recorded.harnessExports.map((entry) => entry.path),
      [first, second]
    )
    assert.equal(recorded.meeting.context, 'Daily / equipe')
    assert.equal((await readdir(join(destination, 'HARNESS'))).length, 2)
    const direct = await exportFinalTranscript({
      ...args,
      destination: join(destination, 'HARNESS')
    })
    assert.equal(
      direct,
      join(destination, 'HARNESS', '2026-11-27 09h05 - Daily - equipe - transcricao final (3).md')
    )
    await exportFinalTranscript({ ...args, destination: root })
    await assert.rejects(exportFinalTranscript({ ...args, folder: root }), /inválida/)
    await writeFile(join(folder, 'reuniao.json'), '{}')
    await assert.rejects(exportFinalTranscript(args), /ainda não está pronta/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two dailies on different days get different files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-export-'))
  try {
    const meetingsDirectory = join(root, 'meetings')
    const destination = join(root, 'HARNESS')
    await mkdir(destination, { recursive: true })
    const monday = await makeMeeting(root, 'segunda', 'Daily', new Date(2026, 10, 23, 9, 0))
    const tuesday = await makeMeeting(root, 'terca', 'Daily', new Date(2026, 10, 24, 9, 0))
    const first = await exportFinalTranscript({ meetingsDirectory, folder: monday, destination })
    const second = await exportFinalTranscript({ meetingsDirectory, folder: tuesday, destination })
    assert.equal(first, join(destination, '2026-11-23 09h00 - Daily - transcricao final.md'))
    assert.equal(second, join(destination, '2026-11-24 09h00 - Daily - transcricao final.md'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
