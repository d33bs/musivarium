/** Immutable model/runtime choices verified against the publisher's repositories. */
export const ASR_MODEL_ID = 'onnx-community/whisper-tiny.en';
export const ASR_MODEL_REVISION = '794207fec2761281fe63a23a94b7e9f53a4efbc1';
export const ASR_SAMPLE_RATE = 16000;
export const ASR_MAX_SECONDS = 90;
export const ASR_CHUNK_OPTIONS = { chunk_length_s: 25, stride_length_s: 5 } as const;

export type AsrProgress = {
  status: 'loading' | 'ready' | 'transcribing';
  message?: string;
  file?: string;
  loaded?: number;
  total?: number;
};
export type AsrResult = {
  text: string;
  modelId: string;
  modelRevision: string;
  loadMs: number;
  transcriptionMs: number;
};
export type AsrWasmPaths = { mjs: string; wasm: string };
export type AsrRequest = {
  id: number;
  samples: Float32Array;
  wasmPaths: AsrWasmPaths;
};
export type AsrResponse =
  | { id: number; type: 'progress'; progress: AsrProgress }
  | { id: number; type: 'result'; result: AsrResult }
  | { id: number; type: 'error'; message: string };

/** Resolve against the page, never against a built /assets/worker-*.js URL. */
export function resolveAsrWasmPaths(baseUrl: string, documentUrl: string): AsrWasmPaths {
  const vendor = new URL('vendor/', new URL(baseUrl, documentUrl));
  return {
    mjs: new URL('ort-wasm-simd-threaded.mjs', vendor).href,
    wasm: new URL('ort-wasm-simd-threaded.wasm', vendor).href,
  };
}

/** Input is mono PCM already resampled to 16 kHz. Transfer may detach its buffer. */
export function validateAsrSamples(samples: Float32Array): void {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new Error('No audio to transcribe. Record a voice note and try again.');
  }
  if (samples.length > ASR_SAMPLE_RATE * ASR_MAX_SECONDS) {
    throw new Error('Voice notes must be 90 seconds or shorter. Record a shorter note and retry.');
  }
  if (!samples.every(Number.isFinite)) {
    throw new Error('The recording contains invalid audio samples. Please record it again.');
  }
}

export function asrErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/out of memory|\boom\b|memory access|allocation|allocate|memory limit/i.test(message)) {
    return 'Not enough browser memory for speech recognition. Close other tabs or record a shorter note, then retry.';
  }
  return (
    'Speech recognition could not finish. Check your connection for the initial model download, then retry. ' +
    message
  );
}
