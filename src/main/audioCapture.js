import { spawn } from 'child_process'

/**
 * Starts PulseAudio recording using 'parec' to capture audio.
 * @param {function(Buffer)} onAudioChunk Callback invoked with raw PCM audio buffer chunks.
 * @param {string} source Either 'system' (default sink monitor) or 'mic' (default source input).
 * @returns {ChildProcess} The spawned parec process instance.
 */
export function startAudioCapture(onAudioChunk, source = 'system') {
  const device = source === 'mic' ? '@DEFAULT_SOURCE@' : '@DEFAULT_SINK@.monitor'
  const args = ['-d', device, '--rate=16000', '--channels=1', '--format=s16le']
  
  console.log(`[Audio Capture] Spawning parec on device: ${device}`)
  const child = spawn('parec', args)

  let lastLogTime = 0

  child.stdout.on('data', (data) => {
    if (typeof onAudioChunk === 'function') {
      onAudioChunk(data)
    }

    const now = Date.now()
    if (now - lastLogTime >= 3000) {
      console.log(`[Audio Capture] Receiving ${source} audio stream...`)
      lastLogTime = now
    }
  })

  child.stderr.on('data', (data) => {
    console.warn(`[Audio Capture] [stderr]: ${data.toString().trim()}`)
  })

  child.on('error', (err) => {
    console.error(`[Audio Capture] process error: ${err.message}`)
  })

  child.on('close', (code) => {
    console.warn(`[Audio Capture] process closed with code ${code}`)
  })

  return child
}
