import { desktopCapturer } from 'electron'
import Tesseract from 'tesseract.js'

/**
 * Captures the primary screen and extracts text using Tesseract.js OCR.
 * @returns {Promise<string>} The extracted text string.
 */
export async function captureScreenAndExtractText() {
  try {
    // 1. Fetch screen sources with 1920x1080 resolution
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })

    const primarySource = sources[0]
    if (!primarySource) {
      throw new Error('No screen source detected.')
    }

    // 2. Convert thumbnail image to a data URL format
    const dataUrl = primarySource.thumbnail.toDataURL()

    // 3. Run Tesseract OCR on the data URL image
    const { data: { text } } = await Tesseract.recognize(dataUrl, 'eng')

    return text ? text.trim() : ''
  } catch (err) {
    console.error(`[Screen Capture] OCR extraction failed: ${err.message}`)
    return ''
  }
}
