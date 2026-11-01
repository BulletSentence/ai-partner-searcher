import fs from 'fs/promises'
import { join } from 'path'

function safeValue(value) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-api-key]')
    .slice(0, 800)
}

/** Writes operational diagnostics only; transcripts, prompts, vault content and keys are never logged. */
export function logRuntimeEvent(event, details = {}) {
  const date = new Date()
  const record = {
    timestamp: date.toISOString(),
    event,
    ...Object.fromEntries(Object.entries(details).map(([key, value]) => [key, safeValue(value)]))
  }
  const fileName = `meeting-copilot-${date.toISOString().slice(0, 10)}.log`
  const filePath = join(process.cwd(), 'logs', fileName)
  fs.mkdir(join(process.cwd(), 'logs'), { recursive: true })
    .then(() => fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8'))
    .catch((error) => console.error(`[Logger] Could not write runtime log: ${error.message}`))
}

export function describeProviderError(error) {
  return {
    name: error?.name || 'Error',
    status: error?.status || '',
    code: error?.code || '',
    message: error?.message || 'Unknown provider error'
  }
}
