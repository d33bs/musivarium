import { prepareAudio } from './audio';

/** One-shot, transferred in-memory PCM. No fetches, persistence or main-thread DSP. */
self.onmessage = ({
  data,
}: MessageEvent<{ chunks: Float32Array[]; frames: number; sampleRate: number }>) => {
  try {
    const mono = new Float32Array(data.frames);
    let offset = 0;
    for (const chunk of data.chunks) {
      mono.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== mono.length) throw new Error('Incomplete microphone audio.');
    const audio = prepareAudio([mono], data.sampleRate);
    self.postMessage({ audio }, { transfer: [audio.samples.buffer] });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Audio preparation failed.',
    });
  }
};
