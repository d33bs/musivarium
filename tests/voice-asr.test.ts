import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsrClient } from '../src/voice/asr-client';
import {
  ASR_MODEL_ID,
  ASR_MODEL_REVISION,
  ASR_CHUNK_OPTIONS,
  asrErrorMessage,
  resolveAsrWasmPaths,
  validateAsrSamples,
  type AsrResponse,
  type AsrResult,
} from '../src/voice/asr-config';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<AsrResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  get id(): number {
    return this.postMessage.mock.calls[0][0].id;
  }
  emit(message: Omit<AsrResponse, 'id'>): void {
    this.onmessage?.({ data: { id: this.id, ...message } } as MessageEvent<AsrResponse>);
  }
}
const result: AsrResult = {
  text: 'The cells look healthy.',
  modelId: ASR_MODEL_ID,
  modelRevision: ASR_MODEL_REVISION,
  loadMs: 12,
  transcriptionMs: 34,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  FakeWorker.instances = [];
});

function setup() {
  vi.stubEnv('BASE_URL', './');
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', { baseURI: 'https://example.org/musivarium/' });
  return new AsrClient();
}
function worker(): FakeWorker {
  return FakeWorker.instances.at(-1)!;
}

describe('lazy ASR client', () => {
  it.each(['loading', 'transcribing'] as const)(
    'cancels during %s, rejects AbortError, and releases worker',
    async (status) => {
      const client = setup();
      expect(FakeWorker.instances).toHaveLength(0);
      const pending = client.transcribe(new Float32Array(16000));
      const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      worker().emit({ type: 'progress', progress: { status } } as Omit<AsrResponse, 'id'>);
      client.cancel();
      await failure;
      expect(worker().terminate).toHaveBeenCalledOnce();
      client.cancel();
      expect(worker().terminate).toHaveBeenCalledOnce();
    },
  );

  it('ignores late callbacks from a cancelled worker after retry and wrong IDs', async () => {
    const client = setup();
    const old = client.transcribe(new Float32Array(16000));
    const failure = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    const stale = worker().onmessage!;
    const oldId = worker().id;
    client.cancel();
    await failure;
    const progress = vi.fn();
    const retry = client.transcribe(new Float32Array(16000), progress);
    stale({ data: { id: oldId, type: 'result', result } } as MessageEvent<AsrResponse>);
    worker().onmessage!({
      data: { id: oldId, type: 'progress', progress: { status: 'ready' } },
    } as MessageEvent<AsrResponse>);
    expect(progress).not.toHaveBeenCalled();
    expect(worker().terminate).not.toHaveBeenCalled();
    worker().emit({ type: 'result', result } as Omit<AsrResponse, 'id'>);
    await expect(retry).resolves.toEqual(result);
    expect(worker().terminate).toHaveBeenCalledOnce();
    expect(worker().onmessage).toBeNull();
  });

  it('transfers audio and passes page-relative absolute runtime URLs', async () => {
    const client = setup();
    const audio = new Float32Array(16000);
    const pending = client.transcribe(audio);
    const [request, transfer] = worker().postMessage.mock.calls[0];
    expect(request.samples).toBe(audio);
    expect(transfer).toEqual([audio.buffer]);
    expect(request.wasmPaths).toEqual(resolveAsrWasmPaths('./', 'https://example.org/musivarium/'));
    worker().emit({ type: 'result', result } as Omit<AsrResponse, 'id'>);
    await pending;
  });

  it('copies subarrays so unrelated audio is not transferred', async () => {
    const client = setup();
    const audio = new Float32Array(32000);
    const pending = client.transcribe(audio.subarray(0, 16000));
    const [request, transfer] = worker().postMessage.mock.calls[0];
    expect(request.samples.length).toBe(16000);
    expect(transfer[0]).not.toBe(audio.buffer);
    worker().emit({ type: 'result', result } as Omit<AsrResponse, 'id'>);
    await pending;
  });

  it('reports file byte progress without letting consumer exceptions leak workers', async () => {
    const client = setup();
    const progress = vi.fn(() => {
      throw new Error('render failed');
    });
    const pending = client.transcribe(new Float32Array(16000), progress);
    const value = {
      status: 'loading' as const,
      file: 'encoder_model_quantized.onnx',
      loaded: 12,
      total: 32,
    };
    worker().emit({ type: 'progress', progress: value } as Omit<AsrResponse, 'id'>);
    expect(progress).toHaveBeenCalledWith(value);
    worker().emit({ type: 'result', result } as Omit<AsrResponse, 'id'>);
    await expect(pending).resolves.toEqual(result);
  });

  it('rejects concurrent requests without stopping the original', async () => {
    const client = setup();
    const pending = client.transcribe(new Float32Array(16000));
    await expect(client.transcribe(new Float32Array(16000))).rejects.toThrow('already running');
    expect(FakeWorker.instances).toHaveLength(1);
    worker().emit({ type: 'result', result } as Omit<AsrResponse, 'id'>);
    await pending;
  });

  it.each(['error', 'crash', 'messageerror', 'postMessage'] as const)(
    'releases on %s and permits retry',
    async (kind) => {
      const client = setup();
      // For synchronous postMessage failure use a subclass, not a separate implementation of the client.
      if (kind === 'postMessage') {
        vi.stubGlobal(
          'Worker',
          class extends FakeWorker {
            postMessage = vi.fn(() => {
              throw new Error('clone failed');
            });
          },
        );
      }
      const pending = client.transcribe(new Float32Array(16000));
      const rejection = expect(pending).rejects.toThrow(/retry/i);
      if (kind === 'error')
        worker().emit({ type: 'error', message: 'Model load failed; please retry.' } as Omit<
          AsrResponse,
          'id'
        >);
      if (kind === 'crash')
        worker().onerror!({
          message: 'out of memory',
          preventDefault: vi.fn(),
        } as unknown as ErrorEvent);
      if (kind === 'messageerror') worker().onmessageerror!();
      await rejection;
      expect(worker().terminate).toHaveBeenCalledOnce();
      vi.stubGlobal('Worker', FakeWorker);
      const retry = client.transcribe(new Float32Array(16000));
      worker().emit({ type: 'result', result } as Omit<AsrResponse, 'id'>);
      await retry;
    },
  );

  it.each([
    new Float32Array(),
    new Float32Array(16000 * 90 + 1),
    Float32Array.of(NaN),
    Float32Array.of(Infinity),
  ])('validates input before worker allocation', async (samples) => {
    const client = setup();
    await expect(client.transcribe(samples)).rejects.toThrow();
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

describe('ASR pinned configuration', () => {
  it('accepts exactly 90 seconds and uses an immutable revision and supported overlap', () => {
    expect(() => validateAsrSamples(new Float32Array(16000 * 90))).not.toThrow();
    expect(ASR_MODEL_REVISION).toMatch(/^[a-f0-9]{40}$/);
    expect(ASR_CHUNK_OPTIONS).toEqual({ chunk_length_s: 25, stride_length_s: 5 });
  });
  it.each(['./', '/musivarium/'])('resolves GitHub Pages runtime URLs for base %s', (base) => {
    expect(resolveAsrWasmPaths(base, 'https://example.org/musivarium/?view=1')).toEqual({
      mjs: 'https://example.org/musivarium/vendor/ort-wasm-simd-threaded.mjs',
      wasm: 'https://example.org/musivarium/vendor/ort-wasm-simd-threaded.wasm',
    });
  });
  it('uses a memory-specific message and actionable download retry', () => {
    expect(asrErrorMessage(new Error('memory access out of bounds'))).toMatch(
      /memory.*shorter.*retry/i,
    );
    expect(asrErrorMessage(new Error('Failed to fetch'))).toMatch(/connection.*download.*retry/i);
  });
});

describe('ASR worker orchestration', () => {
  afterEach(() => {
    vi.doUnmock('@huggingface/transformers');
    vi.resetModules();
  });
  async function setupWorker(fail = false) {
    vi.resetModules();
    const scope = {
      postMessage: vi.fn(),
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined,
    };
    vi.stubGlobal('self', scope);
    const env = { backends: { onnx: { wasm: {} } } };
    const transcriber = vi.fn(async () => ({ text: '  The cells look healthy.  ' }));
    const pipeline = vi.fn(async (_task, _model, options) => {
      if (fail) throw new Error('out of memory');
      options.progress_callback({
        status: 'progress',
        file: 'onnx/encoder_model_quantized.onnx',
        loaded: 12,
        total: 32,
      });
      return transcriber;
    });
    vi.doMock('@huggingface/transformers', () => ({ env, pipeline }));
    await import('../src/voice/asr.worker');
    return { scope, env, pipeline, transcriber };
  }
  it('pins discovery URLs, configures one-thread WASM, forwards file progress and native chunk merging', async () => {
    const { scope, env, pipeline, transcriber } = await setupWorker();
    expect(pipeline).not.toHaveBeenCalled();
    const samples = new Float32Array(16000);
    const wasmPaths = resolveAsrWasmPaths('./', 'https://example.org/musivarium/');
    await scope.onmessage!({ data: { id: 7, samples, wasmPaths } } as MessageEvent);
    expect(env).toMatchObject({
      allowLocalModels: false,
      allowRemoteModels: true,
      useFS: false,
      useFSCache: false,
      experimental_useCrossOriginStorage: false,
      remoteHost: 'https://huggingface.co/',
      remotePathTemplate: `{model}/resolve/${ASR_MODEL_REVISION}/`,
      backends: { onnx: { wasm: { numThreads: 1, proxy: false, wasmPaths } } },
    });
    expect(pipeline).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      ASR_MODEL_ID,
      expect.objectContaining({
        revision: ASR_MODEL_REVISION,
        device: 'wasm',
        dtype: 'q8',
      }),
    );
    expect(transcriber).toHaveBeenCalledWith(samples, { chunk_length_s: 25, stride_length_s: 5 });
    const messages = scope.postMessage.mock.calls.map(([message]) => message);
    expect(messages).toContainEqual({
      id: 7,
      type: 'progress',
      progress: {
        status: 'loading',
        message: 'Loading onnx/encoder_model_quantized.onnx',
        file: 'onnx/encoder_model_quantized.onnx',
        loaded: 12,
        total: 32,
      },
    });
    expect(
      messages
        .slice(-3)
        .map((message) => (message.type === 'progress' ? message.progress.status : message.type)),
    ).toEqual(['ready', 'transcribing', 'result']);
    expect(messages.at(-1)).toEqual({
      id: 7,
      type: 'result',
      result: {
        text: 'The cells look healthy.',
        modelId: ASR_MODEL_ID,
        modelRevision: ASR_MODEL_REVISION,
        loadMs: expect.any(Number),
        transcriptionMs: expect.any(Number),
      },
    });
  });
  it('turns model OOM into actionable retry instead of leaving a pending request', async () => {
    const { scope } = await setupWorker(true);
    await scope.onmessage!({
      data: { id: 8, samples: new Float32Array(16000), wasmPaths: {} },
    } as MessageEvent);
    expect(scope.postMessage).toHaveBeenLastCalledWith({
      id: 8,
      type: 'error',
      message: expect.stringMatching(/memory.*retry/i),
    });
  });
});
