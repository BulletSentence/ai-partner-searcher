// Runs on the audio thread: converts the incoming audio to 16-bit PCM and posts it in 100 ms
// blocks. Unlike a ScriptProcessorNode it is never starved by what the window is rendering,
// so no audio is dropped while the interface is busy.
const BLOCK_SAMPLES = 1600 // 100 ms at 16 kHz

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Int16Array(BLOCK_SAMPLES)
    this.filled = 0
  }

  process(inputs) {
    const channels = inputs[0]
    if (!channels || !channels.length) return true
    const frames = channels[0].length
    for (let index = 0; index < frames; index += 1) {
      // Stereo sources are averaged so neither side of a call is lost.
      let sample = 0
      for (let channel = 0; channel < channels.length; channel += 1)
        sample += channels[channel][index]
      sample = Math.max(-1, Math.min(1, sample / channels.length))
      this.block[this.filled] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      this.filled += 1
      if (this.filled === BLOCK_SAMPLES) {
        const buffer = this.block.buffer
        this.port.postMessage(buffer, [buffer])
        this.block = new Int16Array(BLOCK_SAMPLES)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
