import { VoiceRecorder } from '../../../src/voice/recorder';
import { wavBlob, type PreparedAudio } from '../../../src/voice/audio';

const recorder = new VoiceRecorder();
const tracks: MediaStreamTrack[] = [];
const contexts: AudioContext[] = [];
const workers: { worker: Worker; terminated: boolean }[] = [];
let requestedRate = 48000;
let releasePermission = () => {};
const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (constraints) => {
  const stream = await getUserMedia(constraints);
  tracks.push(...stream.getTracks());
  if (harness.holdPermission)
    await new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
  return stream;
};
const NativeContext = AudioContext;
window.AudioContext = new Proxy(NativeContext, {
  construct(target, args) {
    const context = new target({ ...args[0], sampleRate: requestedRate });
    contexts.push(context);
    return context;
  },
});
const NativeWorker = Worker;
window.Worker = new Proxy(NativeWorker, {
  construct(target, args: [string | URL, WorkerOptions?]) {
    const worker = new target(...args);
    const entry = { worker, terminated: false };
    workers.push(entry);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      entry.terminated = true;
      terminate();
    };
    return worker;
  },
});
const errors: string[] = [];
window.addEventListener('error', (event) => errors.push(event.message));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
window.addEventListener('pagehide', () => recorder.discard());

const harness = {
  rate: 48000,
  tracks,
  contexts,
  errors,
  progress: [] as number[],
  holdPermission: false,
  status: 'idle',
  releasePermission() {
    releasePermission();
  },
  async start() {
    requestedRate = harness.rate;
    harness.status = 'starting';
    try {
      await recorder.start({
        onProgress: (seconds) => harness.progress.push(seconds),
        onError: (error) => errors.push(error.message),
      });
      harness.status = 'recording';
    } catch (error) {
      harness.status = 'idle';
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        errors.push(String(error));
    }
  },
  discard() {
    recorder.discard();
    harness.status = 'idle';
  },
  async stop() {
    const contextRate = contexts.at(-1)!.sampleRate;
    const audio = await recorder.stop();
    const trackStates = tracks.map((track) => track.readyState);
    const contextStates = contexts.map((context) => context.state);
    const workerStates = workers.map((worker) => worker.terminated);
    const decoder = new NativeContext({ sampleRate: 16000 });
    const decoded = await decoder.decodeAudioData(await wavBlob(audio.samples).arrayBuffer());
    await decoder.close();
    harness.status = 'idle';
    return {
      sampleRate: audio.sampleRate,
      durationSeconds: audio.durationSeconds,
      length: audio.samples.length,
      rms: Math.sqrt(
        audio.samples.reduce((sum, value) => sum + value * value, 0) / audio.samples.length,
      ),
      contextRate,
      tracks: trackStates,
      contexts: contextStates,
      workers: workerStates,
      wavRate: decoded.sampleRate,
      wavChannels: decoded.numberOfChannels,
      wavDuration: decoded.duration,
    };
  },
  async offlineLimit(rate: number) {
    const context = new OfflineAudioContext(1, rate * 91, rate);
    await context.audioWorklet.addModule(
      new URL('../../../src/voice/pcm.worklet.js', import.meta.url),
    );
    const node = new AudioWorkletNode(context, 'musivarium-voice-pcm');
    let frames = 0;
    let limit = false;
    let doneCount = 0;
    let progressAt80 = false;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    node.port.onmessage = ({ data }) => {
      if (data.type === 'chunk') {
        frames += data.samples.length;
        if (frames / rate >= 80) progressAt80 = true;
      } else if (data.type === 'done') {
        doneCount++;
        limit = data.limit;
        finished();
      }
    };
    const source = context.createBufferSource();
    const buffer = context.createBuffer(1, rate * 91, rate);
    buffer.getChannelData(0).fill(0.2);
    source.buffer = buffer;
    source.connect(node).connect(context.destination);
    source.start();
    const output = await context.startRendering();
    await done;
    source.disconnect();
    node.disconnect();
    node.port.close();
    return {
      frames,
      limit,
      doneCount,
      progressAt80,
      outputIsSilent: output.getChannelData(0).every((value) => value === 0),
    };
  },
  async longPreparation() {
    const rate = 48000;
    const chunk = new Float32Array(rate * 90);
    const second = Float32Array.from(
      { length: rate },
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate),
    );
    for (let i = 0; i < 90; i++) chunk.set(second, i * rate);
    const worker = new Worker(new URL('../../../src/voice/audio-prep.worker.ts', import.meta.url), {
      type: 'module',
    });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const done = new Promise<PreparedAudio>((resolve, reject) => {
        worker.onmessage = ({ data }) =>
          data.audio ? resolve(data.audio) : reject(new Error(data.error));
        worker.onerror = (event) => reject(new Error(event.message));
      });
      worker.postMessage({ chunks: [chunk], frames: chunk.length, sampleRate: rate }, [
        chunk.buffer,
      ]);
      const transferred = chunk.byteLength === 0;
      const audio = await done;
      return { sampleRate: audio.sampleRate, frames: audio.samples.length, ticks, transferred };
    } finally {
      clearInterval(timer);
      worker.terminate();
    }
  },
};

declare global {
  interface Window {
    voiceHarness: typeof harness;
  }
}
window.voiceHarness = harness;
document.querySelector('#start')!.addEventListener('click', () => {
  void harness.start();
});
document.querySelector('#discard')!.addEventListener('click', () => harness.discard());
