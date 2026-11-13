import {
  ASR_CHUNK_OPTIONS,
  ASR_MODEL_ID,
  ASR_MODEL_REVISION,
  asrErrorMessage,
  validateAsrSamples,
  type AsrProgress,
  type AsrRequest,
  type AsrResponse,
} from './asr-config';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let busy = false;
scope.onmessage = async ({ data }: MessageEvent<AsrRequest>) => {
  if (busy) return; // The client owns one request per worker.
  busy = true;
  const { id, samples, wasmPaths } = data;
  const send = (message: AsrResponse) => scope.postMessage(message);
  const progress = (value: AsrProgress) => send({ id, type: 'progress', progress: value });
  try {
    validateAsrSamples(samples);
    progress({ status: 'loading', message: 'Loading local speech recognition…' });
    const start = performance.now();
    const { env, pipeline } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    env.allowRemoteModels = true; // Downloads weights, never sends audio to remote inference.
    env.remoteHost = 'https://huggingface.co/';
    // 4.3.2's pipeline metadata discovery omits revision. Pin the URL template too,
    // so discovery and actual downloads cannot drift to /resolve/main/.
    env.remotePathTemplate = `{model}/resolve/${ASR_MODEL_REVISION}/`;
    env.useFS = false;
    env.useFSCache = false;
    env.experimental_useCrossOriginStorage = false;
    // ORT Web has no telemetry switch; all inference remains in this worker.
    const wasm = env.backends.onnx.wasm!;
    wasm.numThreads = 1;
    wasm.proxy = false;
    wasm.wasmPaths = wasmPaths;
    const transcriber = await pipeline('automatic-speech-recognition', ASR_MODEL_ID, {
      revision: ASR_MODEL_REVISION,
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (event) => {
        progress({
          status: 'loading',
          message: 'file' in event ? `Loading ${event.file}` : 'Loading speech model…',
          ...('file' in event ? { file: event.file } : {}),
          ...('loaded' in event ? { loaded: event.loaded } : {}),
          ...('total' in event ? { total: event.total } : {}),
        });
      },
    });
    const loadMs = performance.now() - start;
    progress({ status: 'ready', message: 'Speech model ready.' });
    progress({ status: 'transcribing', message: 'Transcribing on this device…' });
    const transcriptionStart = performance.now();
    // Whisper's supported overlap/token merge handles boundaries; never concatenate text manually.
    const output = await transcriber(samples, ASR_CHUNK_OPTIONS);
    if (Array.isArray(output)) throw new Error('Unexpected batched speech recognition response.');
    send({
      id,
      type: 'result',
      result: {
        text: output.text.trim(),
        modelId: ASR_MODEL_ID,
        modelRevision: ASR_MODEL_REVISION,
        loadMs,
        transcriptionMs: performance.now() - transcriptionStart,
      },
    });
    // The client terminates this worker on receipt, freeing all WASM/model memory.
  } catch (error) {
    send({ id, type: 'error', message: asrErrorMessage(error) });
  }
};
