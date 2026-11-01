import fs from 'fs/promises'
import { join } from 'path'

/**
 * Saves the meeting session details, including transcripts and AI history.
 * @param {object} userData Configuration setup details.
 * @param {array} conversationHistory Rolling STT and AI history.
 */
export async function saveMeetingSession(userData, conversationHistory, diagnostics = []) {
  try {
    const dir = join(process.cwd(), 'meetings')
    // Create the meeting history directory if it does not exist.
    await fs.mkdir(dir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/:/g, '-')
    const filename = `meeting_${timestamp}.json`
    const filePath = join(dir, filename)

    const sessionData = {
      timestamp: new Date().toISOString(),
      meeting: {
        context: userData?.meetingContext || 'N/A',
        projectPaths: userData?.projectPaths || 'N/A',
        obsidianVaultPath: userData?.obsidianVaultPath || 'N/A'
      },
      conversationHistory: conversationHistory || [],
      diagnostics
    }

    await fs.writeFile(filePath, JSON.stringify(sessionData, null, 2), 'utf-8')
    console.log(`[Session Logger] Saved session file to: ${filePath}`)
  } catch (err) {
    console.error(`[Session Logger] Failed to save session: ${err.message}`)
  }
}
