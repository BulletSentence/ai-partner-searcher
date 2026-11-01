import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { logRuntimeEvent } from './runtimeLogger'

const execFileAsync = promisify(execFile)

/** Returns the output devices exposed by PulseAudio/PipeWire. */
export async function listAudioOutputs() {
  if (process.platform === 'darwin') {
    try {
      const { stderr } = await execFileAsync('ffmpeg', [
        '-f',
        'avfoundation',
        '-list_devices',
        'true',
        '-i',
        ''
      ])
      const audioSection = stderr.split('AVFoundation audio devices:')[1] || ''
      return [...audioSection.matchAll(/\[(\d+)\]\s+(.+)/g)].map(([, id, label]) => ({
        id,
        label: label.trim()
      }))
    } catch (error) {
      // ffmpeg exits with a non-zero code while listing AVFoundation devices.
      const output = `${error.stderr || ''}`
      const audioSection = output.split('AVFoundation audio devices:')[1] || ''
      const devices = [...audioSection.matchAll(/\[(\d+)\]\s+(.+)/g)].map(([, id, label]) => ({
        id,
        label: label.trim()
      }))
      if (devices.length) return devices
      console.warn(`[Audio Capture] Could not list macOS audio devices: ${error.message}`)
      logRuntimeEvent('audio_devices_list_failed', {
        platform: process.platform,
        code: error.code,
        message: error.message
      })
      return []
    }
  }

  if (process.platform === 'win32') {
    try {
      await execFileAsync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'])
    } catch (error) {
      const output = `${error.stderr || ''}`
      return [...output.matchAll(/"([^"]+)"\s+\(audio\)/g)].map(([, label]) => ({
        id: label,
        label
      }))
    }
  }

  try {
    const { stdout } = await execFileAsync('pactl', ['-f', 'json', 'list', 'sinks'])
    const sinks = JSON.parse(stdout)
    return sinks
      .filter((sink) => sink?.name)
      .map((sink) => ({
        id: sink.name,
        label: sink.description || sink.name
      }))
  } catch (error) {
    console.warn(`[Audio Capture] Could not list output devices: ${error.message}`)
    logRuntimeEvent('audio_devices_list_failed', {
      platform: process.platform,
      code: error.code,
      message: error.message
    })
    return []
  }
}

/**
 * Starts PulseAudio recording using 'parec' to capture audio.
 * @param {function(Buffer)} onAudioChunk Callback invoked with raw PCM audio buffer chunks.
 * @param {string} source Either 'system' (selected sink monitor) or 'mic' (default source input).
 * @param {string} outputDevice PulseAudio sink name to monitor when source is 'system'.
 * @returns {ChildProcess} The spawned parec process instance.
 */
export function startAudioCapture(onAudioChunk, source = 'system', outputDevice = '') {
  if (process.platform === 'darwin') {
    const device = source === 'mic' ? '0' : outputDevice || '0'
    const args = [
      '-f',
      'avfoundation',
      '-i',
      `:${device}`,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      's16le',
      '-loglevel',
      'warning',
      'pipe:1'
    ]
    console.log(`[Audio Capture] Spawning ffmpeg on macOS audio device: ${device}`)
    const child = spawn('ffmpeg', args)
    attachAudioListeners(child, onAudioChunk, source)
    return child
  }

  if (process.platform === 'win32') {
    const args = outputDevice
      ? ['-f', 'dshow', '-i', `audio=${outputDevice}`]
      : ['-f', 'wasapi', '-i', 'default']
    args.push('-ar', '16000', '-ac', '1', '-f', 's16le', '-loglevel', 'warning', 'pipe:1')
    console.log(`[Audio Capture] Spawning ffmpeg on Windows audio device: ${outputDevice || 'default'}`)
    const child = spawn('ffmpeg', args)
    attachAudioListeners(child, onAudioChunk, source)
    return child
  }

  const device =
    source === 'mic' ? '@DEFAULT_SOURCE@' : outputDevice ? `${outputDevice}.monitor` : '@DEFAULT_SINK@.monitor'
  const args = ['-d', device, '--rate=16000', '--channels=1', '--format=s16le']

  console.log(`[Audio Capture] Spawning parec on device: ${device}`)
  const child = spawn('parec', args)

  attachAudioListeners(child, onAudioChunk, source)
  return child
}

function attachAudioListeners(child, onAudioChunk, source) {
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
    logRuntimeEvent('audio_capture_error', {
      platform: process.platform,
      source,
      code: err.code,
      message: err.message
    })
  })

  child.on('close', (code) => {
    console.warn(`[Audio Capture] process closed with code ${code}`)
    if (code !== 0) {
      logRuntimeEvent('audio_capture_closed', { platform: process.platform, source, code })
    }
  })
}
