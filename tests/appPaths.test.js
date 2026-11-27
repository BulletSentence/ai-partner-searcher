import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { resolveAppPaths } from '../src/main/appPaths.js'

const base = {
  cwd: '/projeto',
  documentsDir: '/Users/x/Documents',
  logsDir: '/Users/x/Library/Logs/DataWatch'
}

test('development keeps meetings and logs in the project folder', () => {
  assert.deepEqual(resolveAppPaths({ ...base, isPackaged: false }), {
    meetings: join('/projeto', 'meetings'),
    logs: join('/projeto', 'logs')
  })
})

test('the installed app never writes next to its working directory', () => {
  // Opened from Finder, the working directory is the root of the disk.
  const paths = resolveAppPaths({ ...base, cwd: '/', isPackaged: true })
  assert.equal(paths.meetings, join('/Users/x/Documents', 'DataWatch', 'meetings'))
  assert.equal(paths.logs, '/Users/x/Library/Logs/DataWatch')
})

test('MEETINGS_DIR still wins', () => {
  const env = { MEETINGS_DIR: '/vault/reunioes' }
  assert.equal(resolveAppPaths({ ...base, isPackaged: true, env }).meetings, '/vault/reunioes')
  assert.equal(resolveAppPaths({ ...base, isPackaged: false, env }).meetings, '/vault/reunioes')
})
