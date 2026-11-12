import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportFinalTranscript } from '../src/main/harnessExport.js'

test('exports only the final Markdown into HARNESS and preserves duplicate names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-export-'))
  try {
    const meetingsDirectory = join(root, 'meetings')
    const folder = join(meetingsDirectory, 'daily')
    const destination = join(root, 'vault')
    await mkdir(folder, { recursive: true })
    await mkdir(join(destination, 'HARNESS'), { recursive: true })
    await writeFile(join(folder, 'reuniao.json'), JSON.stringify({ meeting: { context: 'Daily / equipe' }, finalTranscript: [] }))
    await writeFile(join(folder, 'transcricao-final.md'), '# Daily\nTranscrição final')
    const args = { meetingsDirectory, folder, destination }
    const first = await exportFinalTranscript(args)
    const second = await exportFinalTranscript(args)
    assert.equal(first, join(destination, 'HARNESS', 'Daily - equipe - transcricao final.md'))
    assert.notEqual(first, second)
    assert.equal(await readFile(first, 'utf8'), '# Daily\nTranscrição final')
    assert.equal((await readdir(join(destination, 'HARNESS'))).length, 2)
    const direct = await exportFinalTranscript({ ...args, destination: join(destination, 'HARNESS') })
    assert.equal(direct, join(destination, 'HARNESS', 'Daily - equipe - transcricao final (3).md'))
    await exportFinalTranscript({ ...args, destination: root })
    await assert.rejects(exportFinalTranscript({ ...args, folder: root }), /inválida/)
    await writeFile(join(folder, 'reuniao.json'), '{}')
    await assert.rejects(exportFinalTranscript(args), /ainda não está pronta/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
