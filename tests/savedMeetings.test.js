import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveSavedMeetingPath } from '../src/main/meetingRecorder.js'

test('only entries directly inside the meetings directory can be deleted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'saved-meetings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const meetings = join(root, 'meetings')
  await mkdir(join(meetings, '2026-11-27_10-00'), { recursive: true })
  await writeFile(join(meetings, 'antiga.json'), '{}')
  await writeFile(join(meetings, 'notas.txt'), 'x')
  await symlink(root, join(meetings, 'atalho'))

  assert.equal(
    await resolveSavedMeetingPath(meetings, '2026-11-27_10-00'),
    join(meetings, '2026-11-27_10-00')
  )
  assert.equal(
    await resolveSavedMeetingPath(meetings, 'antiga.json'),
    join(meetings, 'antiga.json')
  )
  for (const name of ['..', '.', '', '../meetings', 'notas.txt', 'atalho', 'nao-existe', null]) {
    assert.equal(await resolveSavedMeetingPath(meetings, name), null, String(name))
  }
})
