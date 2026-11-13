import { AsrClient, type AsrProgress } from '../../src/voice/asr-client';

const client = new AsrClient();
const harness = {
  progress: [] as AsrProgress[],
  run: (samples: number[]) => {
    harness.progress = [];
    return client.transcribe(Float32Array.from(samples), (value) => harness.progress.push(value));
  },
  cancel: () => client.cancel(),
  cancelDuring: async (samples: number[], phase: 'download' | 'transcribing') => {
    try {
      await client.transcribe(Float32Array.from(samples), (value) => {
        const downloading =
          value.file?.endsWith('.onnx') && value.loaded !== undefined && value.loaded > 0;
        if (
          (phase === 'download' && downloading) ||
          (phase === 'transcribing' && value.status === 'transcribing')
        )
          client.cancel();
      });
      throw new Error('Expected real worker cancellation.');
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error;
      return { name: error.name, message: error.message, phase };
    }
  },
};
Object.assign(window, { asrValidation: harness });
