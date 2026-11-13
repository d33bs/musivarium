import {
  asrErrorMessage,
  resolveAsrWasmPaths,
  validateAsrSamples,
  type AsrProgress,
  type AsrRequest,
  type AsrResponse,
  type AsrResult,
} from './asr-config';
export type { AsrProgress, AsrResult } from './asr-config';

type Pending = {
  id: number;
  worker: Worker;
  resolve: (result: AsrResult) => void;
  reject: (error: Error) => void;
  progress?: (progress: AsrProgress) => void;
};

/** One short-lived worker per transcription; no model is loaded at application startup. */
export class AsrClient {
  private pending?: Pending;
  private nextId = 0;

  async transcribe(
    samples: Float32Array,
    onProgress?: (progress: AsrProgress) => void,
  ): Promise<AsrResult> {
    validateAsrSamples(samples);
    if (this.pending)
      throw new Error('Speech recognition is already running. Cancel it before retrying.');
    const wasmPaths = resolveAsrWasmPaths(import.meta.env.BASE_URL, document.baseURI);
    // Never retain or transfer unrelated samples from a subarray/shared buffer.
    const audio =
      samples.buffer instanceof ArrayBuffer && samples.byteLength === samples.buffer.byteLength
        ? samples
        : samples.slice();
    const worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' });
    return new Promise<AsrResult>((resolve, reject) => {
      const pending: Pending = { id: ++this.nextId, worker, resolve, reject, progress: onProgress };
      this.pending = pending;
      worker.onmessage = ({ data }: MessageEvent<AsrResponse>) => {
        if (this.pending !== pending || data.id !== pending.id) return;
        if (data.type === 'progress') {
          // A consumer's rendering error must not prevent cancellation or worker cleanup.
          try {
            pending.progress?.(data.progress);
          } catch {
            /* consumer callback */
          }
        } else {
          this.release(pending);
          if (data.type === 'result') resolve(data.result);
          else reject(new Error(data.message));
        }
      };
      worker.onerror = (event) => {
        if (this.pending !== pending) return;
        event.preventDefault?.();
        this.release(pending);
        reject(
          new Error(asrErrorMessage(event.message || 'The speech worker stopped unexpectedly.')),
        );
      };
      worker.onmessageerror = () => {
        if (this.pending !== pending) return;
        this.release(pending);
        reject(new Error('The speech worker could not read the recording. Please retry.'));
      };
      try {
        worker.postMessage({ id: pending.id, samples: audio, wasmPaths } satisfies AsrRequest, [
          audio.buffer as ArrayBuffer,
        ]);
      } catch (error) {
        this.release(pending);
        reject(new Error(asrErrorMessage(error)));
      }
    });
  }

  /** Terminates even a blocked model download or synchronous WASM inference. */
  cancel(): void {
    const pending = this.pending;
    if (!pending) return;
    this.release(pending);
    pending.reject(new DOMException('Speech recognition cancelled.', 'AbortError'));
  }

  private release(pending: Pending): void {
    if (this.pending !== pending) return;
    this.pending = undefined;
    pending.worker.onmessage = null;
    pending.worker.onerror = null;
    pending.worker.onmessageerror = null;
    pending.worker.terminate();
  }
}
