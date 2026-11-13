/* Runs exclusively on the audio rendering thread; no UI timers or storage. */
class VoicePCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(4096);
    this.offset = 0;
    this.frames = 0;
    this.maximumFrames = Math.floor(sampleRate * 90);
    this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'stop') this.finish(false);
    };
  }

  flush() {
    if (!this.offset) return;
    const samples = this.chunk.slice(0, this.offset);
    this.port.postMessage({ type: 'chunk', samples, frames: this.frames }, [samples.buffer]);
    this.offset = 0;
  }

  finish(limit) {
    if (this.finished) return;
    this.finished = true;
    this.flush();
    this.port.postMessage({ type: 'done', frames: this.frames, limit });
  }

  process(inputs) {
    if (this.finished) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const count = Math.min(channels[0].length, this.maximumFrames - this.frames);
    for (let i = 0; i < count; i++) {
      let mono = 0;
      for (const channel of channels) {
        if (!Number.isFinite(channel[i])) {
          this.finished = true;
          this.port.postMessage({
            type: 'error',
            message: 'Microphone produced non-finite audio.',
          });
          return false;
        }
        mono += channel[i] / channels.length;
      }
      this.chunk[this.offset++] = mono;
      this.frames++;
      if (this.offset === this.chunk.length) this.flush();
    }
    if (this.frames >= this.maximumFrames) this.finish(true);
    // Outputs remain their initial zeros: never feed microphone audio to speakers.
    return !this.finished;
  }
}

registerProcessor('musivarium-voice-pcm', VoicePCMProcessor);
