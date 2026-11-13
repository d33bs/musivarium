import { MAX_RECORDING_SECONDS, type PreparedAudio } from './audio';

export type { PreparedAudio } from './audio';

export interface RecordingOptions {
  /** Sample-clock elapsed time (~85–93 ms batches), including the 80-second warning threshold. */
  onProgress?: (seconds: number) => void;
  /** Capture has already stopped and released the microphone when called. Call stop() to prepare it. */
  onLimit?: () => void;
  onError?: (error: Error) => void;
}

interface Session {
  options: RecordingOptions;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  node?: AudioWorkletNode;
  chunks: Float32Array[];
  frames: number;
  started: boolean;
  finished: boolean;
  cancelled: boolean;
  error?: Error;
  abort: Promise<never>;
  cancel: (error: Error) => void;
  done: Promise<void>;
  finish: () => void;
  ended: () => void;
  closing?: Promise<void>;
  stopping?: Promise<PreparedAudio>;
  worker?: Worker;
}

export function microphoneError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was denied. Allow microphone access in your browser and try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return 'No microphone was found. Connect a microphone and try again.';
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return 'Cannot access the microphone. It may be busy in another application.';
  if (name === 'OverconstrainedError')
    return 'This microphone does not support the requested recording settings.';
  return error instanceof Error && error.message
    ? error.message
    : 'Microphone recording failed. Please try again.';
}

const cancelledError = () => new DOMException('Recording was discarded.', 'AbortError');

// UI callback failures must not leak a live microphone or break flush acknowledgement.
function notify<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    /* Consumer owns its UI errors. */
  }
}

/** In-memory PCM capture. Call start() from a user gesture; discard() on pagehide/cancel. */
export class VoiceRecorder {
  private session?: Session;

  async start(options: RecordingOptions = {}): Promise<void> {
    if (this.session) throw new Error('A recording is already active. Stop or discard it first.');
    if (globalThis.isSecureContext === false)
      throw new Error('Microphone recording requires HTTPS or a secure localhost connection.');
    if (
      !globalThis.navigator?.mediaDevices?.getUserMedia ||
      typeof AudioContext === 'undefined' ||
      typeof AudioWorkletNode === 'undefined'
    ) {
      throw new Error('This browser does not support microphone AudioWorklet recording.');
    }
    let cancel!: Session['cancel'];
    let finish!: Session['finish'];
    const abort = new Promise<never>((_, reject) => {
      cancel = reject;
    });
    // Cancellation can happen between awaits, before a new race is attached.
    void abort.catch(() => {});
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session: Session = {
      options,
      chunks: [],
      frames: 0,
      started: false,
      finished: false,
      cancelled: false,
      abort,
      cancel,
      done,
      finish,
      ended: () => this.fail(session, new Error('Microphone disconnected during recording.')),
    };
    this.session = session;
    const current = () => this.session === session && !session.cancelled;
    try {
      const permission = navigator.mediaDevices
        .getUserMedia({
          audio: {
            channelCount: { ideal: 1 },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
        .then((stream) => {
          // getUserMedia has no abort API. Late permission grants are always stopped.
          if (!current()) for (const track of stream.getTracks()) track.stop();
          else session.stream = stream; // Own it before any continuation can be discarded.
          return stream;
        });
      session.stream = await Promise.race([permission, abort]);
      this.check(session);
      session.context = new AudioContext(); // Use the actual native rate, never assume 48 kHz.
      if (!session.context.audioWorklet)
        throw new Error('This browser does not support AudioWorklet recording.');
      for (const track of session.stream.getTracks())
        track.addEventListener('ended', session.ended);
      if (session.stream.getAudioTracks().some((track) => track.readyState === 'ended'))
        throw new Error('Microphone disconnected before recording started.');
      await Promise.race([
        session.context.audioWorklet.addModule(new URL('./pcm.worklet.js', import.meta.url)),
        abort,
      ]);
      this.check(session);
      session.node = new AudioWorkletNode(session.context, 'musivarium-voice-pcm', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      session.node.onprocessorerror = () =>
        this.fail(session, new Error('Microphone audio processor failed. Please record again.'));
      session.node.port.onmessage = ({ data }) => {
        if (!current() || session.finished) return;
        if (data.type === 'error') {
          this.fail(session, new Error(data.message || 'Microphone audio processor failed.'));
        } else if (data.type === 'chunk') {
          const samples = data.samples as Float32Array;
          if (
            !(samples instanceof Float32Array) ||
            session.frames + samples.length > session.context!.sampleRate * MAX_RECORDING_SECONDS
          ) {
            this.fail(session, new Error('Invalid microphone audio chunk.'));
            return;
          }
          session.chunks.push(samples);
          session.frames += samples.length;
          notify(options.onProgress, session.frames / session.context!.sampleRate);
        } else if (data.type === 'done') {
          session.finished = true;
          session.finish();
          if (data.limit) {
            void this.release(session);
            notify(options.onLimit, undefined);
          }
        }
      };
      session.source = session.context.createMediaStreamSource(session.stream);
      session.source.connect(session.node);
      // The worklet writes no output (digital silence), so no microphone feedback.
      session.node.connect(session.context.destination);
      await Promise.race([session.context.resume(), abort]);
      this.check(session);
      session.started = true;
    } catch (error) {
      await this.release(session);
      session.chunks.length = 0;
      if (this.session === session) this.session = undefined;
      if (session.cancelled) throw session.error ?? cancelledError();
      throw new Error(microphoneError(error));
    }
  }

  stop(): Promise<PreparedAudio> {
    const session = this.session;
    if (!session?.started || session.cancelled) {
      if (session) this.discard();
      return Promise.reject(session?.error ?? new Error('No recording is ready to stop.'));
    }
    if (session.stopping) return session.stopping;
    // Stop hardware immediately, before waiting for the worklet or doing DSP.
    this.stopTracks(session);
    session.source?.disconnect();
    session.stopping = this.prepare(session);
    return session.stopping;
  }

  /** Synchronous invalidation, track stop and context close request. Safe while start/stop is pending. */
  discard(): void {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    session.cancelled = true;
    session.cancel(cancelledError());
    this.terminatePreparation(session);
    session.chunks.length = 0;
    void this.release(session);
  }

  private check(session: Session): void {
    if (session.cancelled || this.session !== session) throw session.error ?? cancelledError();
  }

  private stopTracks(session: Session): void {
    for (const track of session.stream?.getTracks() ?? []) {
      track.removeEventListener('ended', session.ended);
      if (track.readyState !== 'ended') track.stop();
    }
  }

  private release(session: Session): Promise<void> {
    if (session.closing) return session.closing;
    this.stopTracks(session);
    session.source?.disconnect();
    session.node?.disconnect();
    if (session.node) {
      session.node.onprocessorerror = null;
      session.node.port.onmessage = null;
      session.node.port.close();
    }
    session.closing =
      session.context && session.context.state !== 'closed'
        ? session.context.close().catch(() => {})
        : Promise.resolve();
    return session.closing;
  }

  private fail(session: Session, error: Error): void {
    if (session.cancelled || this.session !== session) return;
    session.error = error;
    session.cancelled = true;
    session.cancel(error);
    session.chunks.length = 0;
    void this.release(session);
    notify(session.options.onError, error);
  }

  private terminatePreparation(session: Session): void {
    if (!session.worker) return;
    session.worker.onmessage = null;
    session.worker.onerror = null;
    session.worker.onmessageerror = null;
    session.worker.terminate();
    session.worker = undefined;
  }

  private async prepare(session: Session): Promise<PreparedAudio> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!session.finished) {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Microphone audio flush timed out. Please record again.')),
            2000,
          );
        });
        session.node!.port.postMessage({ type: 'stop' });
        await Promise.race([session.done, session.abort, timeout]);
      }
      await this.release(session);
      this.check(session);
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const worker = new Worker(new URL('./audio-prep.worker.ts', import.meta.url), {
        type: 'module',
      });
      session.worker = worker;
      const prepared = new Promise<PreparedAudio>((resolve, reject) => {
        worker.onmessage = ({ data }: MessageEvent<{ audio?: PreparedAudio; error?: string }>) => {
          if (data.error) reject(new Error(data.error));
          else if (data.audio) resolve(data.audio);
          else reject(new Error('Audio preparation returned no audio.'));
        };
        worker.onerror = (event) => {
          event.preventDefault();
          reject(new Error(event.message || 'Audio preparation worker failed.'));
        };
        worker.onmessageerror = () => reject(new Error('Cannot read prepared microphone audio.'));
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Audio preparation timed out. Please record again.')),
          30000,
        );
      });
      const chunks = session.chunks;
      worker.postMessage(
        { chunks, frames: session.frames, sampleRate: session.context!.sampleRate },
        chunks.map((chunk) => chunk.buffer),
      );
      session.chunks = [];
      const result = await Promise.race([prepared, session.abort, timeout]);
      this.check(session);
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.terminatePreparation(session);
      await this.release(session);
      session.chunks.length = 0;
      if (this.session === session) this.session = undefined;
    }
  }
}
