import { app } from 'electron'
import fs from 'fs/promises'
import { join } from 'path'

const settingsFileName = 'meeting-settings.json'
const allowedFields = [
  'meetingContext',
  'harnessPath',
  'projectPaths',
  'obsidianVaultPath',
  'audioOutputDevice',
  'transcriberModel',
  'language',
  'useOllama',
  'openaiModel',
  'autoAnswer',
  'showLivePreview',
  'transcriptCollapsed',
  'answerCount',
  'autoHeight',
  'showManualQuestion'
]

function getSettingsPath() {
  return join(app.getPath('userData'), settingsFileName)
}

function selectAllowedSettings(value = {}) {
  return Object.fromEntries(
    allowedFields.filter((field) => field in value).map((field) => [field, value[field]])
  )
}

export async function getMeetingSettings() {
  try {
    return selectAllowedSettings(JSON.parse(await fs.readFile(getSettingsPath(), 'utf8')))
  } catch (error) {
    if (error.code !== 'ENOENT')
      console.warn(`[Settings] Could not read meeting settings: ${error.message}`)
    return {}
  }
}

export async function saveMeetingSettings(settings) {
  const filePath = getSettingsPath()
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(selectAllowedSettings(settings), null, 2), 'utf8')
}
