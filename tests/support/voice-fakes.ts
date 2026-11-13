import { vi } from 'vitest';
import { prepareAudio, type PreparedAudio } from '../../src/voice/audio';

/** Deliberate Web Audio API doubles for lifecycle races, not browser proof. */
export function audioFakes() {
  const tracks: FakeTrack[] = [];
  const contexts: FakeContext[] = [];
  const nodes: FakeNode[] = [];
  class FakeTrack extends EventTarget {
    readyState = 'live';
    stop = vi.fn(() => {
      this.readyState = 'ended';
    });
  }
  const makeStream = () => {
    const track = new FakeTrack();
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  };
  const getUserMedia = vi.fn(async () => makeStream());
  const addModule = vi.fn(async (_url: string | URL) => {});
  const resume = vi.fn(async () => {});
  class FakeContext {
    sampleRate = 48000;
    state = 'running';
    destination = {};
    audioWorklet = { addModule };
    resume = resume;
    onstatechange = null;
    source = { connect: vi.fn(), disconnect: vi.fn() };
    createMediaStreamSource = vi.fn(() => this.source);
    close = vi.fn(async () => {
      this.state = 'closed';
    });
    constructor() {
      contexts.push(this);
    }
  }
  class FakeNode extends EventTarget {
    onprocessorerror: (() => void) | null = null;
    connect = vi.fn();
    disconnect = vi.fn();
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      close: vi.fn(),
      postMessage: vi.fn((data: { type: string }) => {
        if (data.type === 'stop')
          queueMicrotask(() => {
            this.emit({ type: 'chunk', samples: new Float32Array(128).fill(0.1), frames: 48128 });
            this.emit({ type: 'done', frames: 48128, limit: false });
          });
      }),
    };
    constructor() {
      super();
      nodes.push(this);
    }
    emit(data: unknown) {
      this.port.onmessage?.({ data });
    }
  }
  const workers: FakeWorker[] = [];
  const workerControl = { auto: true };
  class FakeWorker {
    onmessage: ((event: { data: { audio?: PreparedAudio; error?: string } }) => void) | null = null;
    onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn(
      (
        data: { chunks: Float32Array[]; frames: number; sampleRate: number },
        _transfer?: Transferable[],
      ) => {
        if (!workerControl.auto) return;
        queueMicrotask(() => {
          try {
            const mono = new Float32Array(data.frames);
            let offset = 0;
            for (const chunk of data.chunks) {
              mono.set(chunk, offset);
              offset += chunk.length;
            }
            this.onmessage?.({ data: { audio: prepareAudio([mono], data.sampleRate) } });
          } catch (error) {
            this.onmessage?.({ data: { error: (error as Error).message } });
          }
        });
      },
    );
    constructor() {
      workers.push(this);
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  return {
    tracks,
    contexts,
    nodes,
    workers,
    workerControl,
    getUserMedia,
    makeStream,
    addModule,
    resume,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
