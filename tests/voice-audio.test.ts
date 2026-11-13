import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceRecorder, microphoneError } from '../src/voice/recorder';
import { audioFakes, deferred } from './support/voice-fakes';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
import { downmixChannels, resampleMono, prepareAudio, wavBlob } from '../src/voice/audio';

function tone(rate: number, seconds = 1, hz = 440, amplitude = 0.3): Float32Array {
  return Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / rate),
  );
}
function rms(values: Float32Array): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

describe('VoiceRecorder lifecycle', () => {
  it('transfers chunks to a preparation worker after releasing capture and terminates the worker', async () => {
    const fake = audioFakes();
    const recorder = new VoiceRecorder();
    await recorder.start();
    const chunk = tone(48000);
    fake.nodes[0].emit({ type: 'chunk', samples: chunk, frames: 48000 });
    await recorder.stop();
    expect(fake.workers).toHaveLength(1);
    const [data, transfer] = fake.workers[0].postMessage.mock.calls[0];
    expect(data.chunks[0]).toBe(chunk);
    expect(transfer).toContain(chunk.buffer);
    expect(fake.contexts[0].state).toBe('closed');
    expect(fake.workers[0].terminate).toHaveBeenCalledTimes(1);
  });
  it('cancels preparation without leaving a worker or returning stale audio', async () => {
    const fake = audioFakes();
    fake.workerControl.auto = false;
    const recorder = new VoiceRecorder();
    await recorder.start();
    fake.nodes[0].emit({ type: 'chunk', samples: tone(48000), frames: 48000 });
    const stopped = recorder.stop().catch((error) => error as Error);
    await vi.waitFor(() => expect(fake.workers).toHaveLength(1));
    recorder.discard();
    expect(fake.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(await stopped).toMatchObject({ name: 'AbortError' });
    await recorder.start();
    recorder.discard();
  });
  it('terminates a failed preparation worker and allows retry', async () => {
    const fake = audioFakes();
    fake.workerControl.auto = false;
    const recorder = new VoiceRecorder();
    await recorder.start();
    fake.nodes[0].emit({ type: 'chunk', samples: tone(48000), frames: 48000 });
    const stopped = recorder.stop().catch((error) => error as Error);
    await vi.waitFor(() => expect(fake.workers).toHaveLength(1));
    fake.workers[0].onerror?.({ message: 'worker failed', preventDefault: vi.fn() });
    expect(await stopped).toMatchObject({ message: expect.stringMatching(/worker failed/) });
    expect(fake.workers[0].terminate).toHaveBeenCalledTimes(1);
    await recorder.start();
    recorder.discard();
  });
  it('records native-rate chunks, flushes trailing PCM and closes mic before preparing', async () => {
    const fake = audioFakes();
    const recorder = new VoiceRecorder();
    const onProgress = vi.fn();
    await recorder.start({ onProgress });
    expect(fake.getUserMedia).toHaveBeenCalledWith({ audio: expect.any(Object), video: false });
    expect(fake.addModule.mock.calls[0][0].toString()).toContain('pcm.worklet.js');
    fake.nodes[0].emit({ type: 'chunk', samples: tone(48000), frames: 48000 });
    expect(onProgress).toHaveBeenLastCalledWith(1);
    const stopping = recorder.stop();
    expect(fake.tracks[0].stop).toHaveBeenCalledTimes(1);
    const prepared = await stopping;
    expect(prepared.samples).toHaveLength(Math.round(48128 / 3));
    expect(prepared.sampleRate).toBe(16000);
    expect(fake.contexts[0].state).toBe('closed');
    expect(fake.nodes[0].disconnect).toHaveBeenCalled();
    expect(fake.nodes[0].port.close).toHaveBeenCalled();
    expect(fake.contexts[0].source.disconnect).toHaveBeenCalled();
    await recorder.start();
    recorder.discard();
  });
  it('rejects unsupported or insecure environments with useful error messages', async () => {
    audioFakes();
    vi.stubGlobal('isSecureContext', false);
    await expect(new VoiceRecorder().start()).rejects.toThrow(/HTTPS|secure/i);
    expect(microphoneError(new DOMException('denied', 'NotAllowedError'))).toMatch(/permission/i);
    expect(microphoneError(new DOMException('', 'NotFoundError'))).toMatch(/microphone/i);
    expect(microphoneError(new DOMException('', 'NotReadableError'))).toMatch(/busy|use|access/i);
    expect(microphoneError(new Error('specific failure'))).toBe('specific failure');
  });
  it('discards permission-pending capture and stops any late granted stream', async () => {
    const fake = audioFakes();
    const permission = deferred<MediaStream>();
    fake.getUserMedia.mockReturnValue(permission.promise);
    const recorder = new VoiceRecorder();
    const starting = recorder.start().catch((error) => error as Error);
    await Promise.resolve();
    recorder.discard();
    permission.resolve(fake.makeStream());
    expect(await starting).toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.tracks[0].readyState).toBe('ended');
    expect(fake.contexts).toHaveLength(0);
    await expect(recorder.stop()).rejects.toThrow(/record/i);
  });
  it('stops a stream discarded between permission settlement and the start continuation', async () => {
    const fake = audioFakes();
    const permission = deferred<MediaStream>();
    fake.getUserMedia.mockReturnValue(permission.promise);
    const recorder = new VoiceRecorder();
    const starting = recorder.start().catch((error) => error as Error);
    permission.resolve(fake.makeStream());
    queueMicrotask(() => recorder.discard());
    expect(await starting).toMatchObject({ name: 'AbortError' });
    expect(fake.tracks[0].readyState).toBe('ended');
    expect(fake.contexts).toHaveLength(0);
  });
  it('cleans up a pending module load on discard without reviving the old capture', async () => {
    const fake = audioFakes();
    const loading = deferred<void>();
    fake.addModule.mockReturnValue(loading.promise);
    const recorder = new VoiceRecorder();
    const starting = recorder.start().catch((error) => error as Error);
    await vi.waitFor(() => expect(fake.addModule).toHaveBeenCalled());
    recorder.discard();
    expect(fake.tracks[0].readyState).toBe('ended');
    loading.resolve();
    expect(await starting).toMatchObject({ name: 'AbortError' });
    expect(fake.contexts[0].state).toBe('closed');
    expect(fake.nodes).toHaveLength(0);
  });
  it('cleans up denied permission and module startup errors and permits retry', async () => {
    const fake = audioFakes();
    const recorder = new VoiceRecorder();
    fake.getUserMedia.mockRejectedValueOnce(new DOMException('', 'NotAllowedError'));
    await expect(recorder.start()).rejects.toThrow(/permission/i);
    fake.addModule.mockRejectedValueOnce(new Error('worklet load failed'));
    await expect(recorder.start()).rejects.toThrow(/worklet load/);
    expect(fake.tracks[0].readyState).toBe('ended');
    expect(fake.contexts[0].state).toBe('closed');
    await recorder.start();
    recorder.discard();
  });
  it('rejects concurrent starts, releases synchronously on discard, and drops queued audio', async () => {
    const fake = audioFakes();
    const recorder = new VoiceRecorder();
    await recorder.start();
    await expect(recorder.start()).rejects.toThrow(/already|record/i);
    const progress = vi.fn();
    recorder.discard();
    expect(fake.tracks[0].readyState).toBe('ended');
    expect(fake.contexts[0].state).toBe('closed');
    await recorder.start({ onProgress: progress });
    fake.nodes[0].emit({ type: 'chunk', samples: tone(48000), frames: 48000 });
    expect(progress).not.toHaveBeenCalled();
    recorder.discard();
    recorder.discard();
  });
  it('auto-releases at worklet limit and keeps the capped audio available to stop', async () => {
    const fake = audioFakes();
    const recorder = new VoiceRecorder();
    let stopping: ReturnType<VoiceRecorder['stop']> | undefined;
    const onLimit = vi.fn(() => {
      expect(fake.tracks[0].readyState).toBe('ended');
      stopping = recorder.stop(); // UI may stop immediately inside the limit callback.
    });
    const onProgress = vi.fn();
    await recorder.start({ onLimit, onProgress });
    fake.nodes[0].emit({ type: 'chunk', samples: tone(48000), frames: 48000 });
    fake.nodes[0].emit({ type: 'done', frames: 48000, limit: true });
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(fake.tracks[0].readyState).toBe('ended');
    expect((await stopping!).samples).toHaveLength(16000);
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });
  it.each(['processor', 'track'])(
    'releases the microphone on asynchronous %s failure',
    async (kind) => {
      const fake = audioFakes();
      const recorder = new VoiceRecorder();
      const onError = vi.fn();
      await recorder.start({ onError });
      if (kind === 'processor') fake.nodes[0].onprocessorerror?.();
      else fake.tracks[0].dispatchEvent(new Event('ended'));
      expect(onError).toHaveBeenCalledTimes(1);
      expect(fake.tracks[0].readyState).toBe('ended');
      expect(fake.contexts[0].state).toBe('closed');
      await expect(recorder.stop()).rejects.toThrow();
    },
  );
});

// A DSP harness: same worklet source, simulated render quanta, no wall timers.
function worklet(rate = 48000) {
  const messages: { type: string; samples?: Float32Array; frames?: number; limit?: boolean }[] = [];
  let Processor: new () => {
    process(inputs: Float32Array[][]): boolean;
    port: { onmessage: (event: { data: { type: string } }) => void };
  };
  class Base {
    port = {
      onmessage: null,
      postMessage: (data: (typeof messages)[number]) => messages.push(data),
    };
  }
  runInNewContext(readFileSync(new URL('../src/voice/pcm.worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: Base,
    sampleRate: rate,
    Float32Array,
    registerProcessor: (_: string, ctor: typeof Processor) => {
      Processor = ctor;
    },
  });
  return { processor: new Processor!(), messages };
}

describe('PCM worklet sample-clock capture', () => {
  it('batches mono downmix and flushes the trailing partial chunk on stop', () => {
    const { processor, messages } = worklet();
    for (let i = 0; i < 33; i++)
      expect(
        processor.process([[new Float32Array(128).fill(0.2), new Float32Array(128).fill(0.6)]]),
      ).toBe(true);
    const chunks = messages.filter((m) => m.type === 'chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].samples).toHaveLength(4096);
    expect(chunks[0].samples![20]).toBeCloseTo(0.4);
    processor.port.onmessage({ data: { type: 'stop' } });
    expect(messages.filter((m) => m.type === 'chunk').map((m) => m.samples!.length)).toEqual([
      4096, 128,
    ]);
    expect(messages.at(-1)).toMatchObject({ type: 'done', frames: 4224, limit: false });
    expect(processor.process([[new Float32Array(128)]])).toBe(false);
  });
  it.each([44100, 48000])('enforces exactly 90 seconds at %i Hz without UI timers', (rate) => {
    const { processor, messages } = worklet(rate);
    const block = [new Float32Array(128).fill(0.1)];
    for (let frame = 0; frame < rate * 91; frame += 128) processor.process([block]);
    const chunks = messages.filter((m) => m.type === 'chunk');
    expect(chunks.reduce((n, m) => n + m.samples!.length, 0)).toBe(rate * 90);
    expect(messages.filter((m) => m.type === 'done')).toEqual([
      { type: 'done', frames: rate * 90, limit: true },
    ]);
    expect(messages.some((m) => m.type === 'chunk' && m.frames! / rate >= 80)).toBe(true);
  });
  it('fails explicitly rather than persisting non-finite input', () => {
    const { processor, messages } = worklet();
    expect(processor.process([[Float32Array.of(NaN)]])).toBe(false);
    expect(messages.at(-1)).toMatchObject({ type: 'error' });
  });
});

// Generated mathematical signals test DSP, not human speech recognition.
describe('voice audio preparation', () => {
  it('encodes inspectable PCM16 mono 16-kHz WAV without changing PCM', async () => {
    const samples = Float32Array.of(-2, -1, 0, 0.5, 1, 2);
    const blob = wavBlob(samples);
    expect(blob.type).toBe('audio/wav');
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    expect(new TextDecoder().decode(buffer.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(buffer.slice(8, 16))).toBe('WAVEfmt ');
    expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([
      -32768, -32768, 0, 16384, 32767, 32767,
    ]);
    expect(samples[0]).toBe(-2);
    expect(() => wavBlob(Float32Array.of(NaN))).toThrow(/finite/i);
  });
  it('rejects empty, too-short, silent, constant, non-finite and over-limit recordings', () => {
    expect(() => prepareAudio([new Float32Array()], 16000)).toThrow(/empty/i);
    expect(() => prepareAudio([tone(16000, 0.1)], 16000)).toThrow(/short/i);
    expect(() => prepareAudio([new Float32Array(16000)], 16000)).toThrow(/silent|speech/i);
    expect(() => prepareAudio([new Float32Array(16000).fill(0.5)], 16000)).toThrow(
      /silent|speech/i,
    );
    const bad = tone(16000);
    bad[200] = Infinity;
    expect(() => prepareAudio([bad], 16000)).toThrow(/finite/i);
    expect(() => prepareAudio([new Float32Array(16000 * 90 + 1)], 16000)).toThrow(/90/);
    expect(() => prepareAudio([tone(16000)], 0)).toThrow(/rate/i);
  });
  it('warns about quiet or clipped input and bounds prepared PCM', () => {
    expect(prepareAudio([tone(16000, 1, 440, 0.003)], 16000).warnings.join(' ')).toMatch(/quiet/i);
    const result = prepareAudio([tone(48000, 1, 440, 1.3)], 48000);
    expect(result.warnings.join(' ')).toMatch(/clip/i);
    expect(result.samples.every((v) => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
  });
  it('rejects a signal whose energy is entirely removed by anti-aliasing', () => {
    expect(() => prepareAudio([tone(48000, 1, 12000)], 48000)).toThrow(/silent|speech/i);
  });
  it('prepares owned 16-kHz mono samples with duration and warnings', () => {
    const prepared = prepareAudio([tone(48000), tone(48000)], 48000);
    expect(prepared.sampleRate).toBe(16000);
    expect(prepared.durationSeconds).toBe(1);
    expect(prepared.warnings).toEqual([]);
    expect(prepared.samples).toHaveLength(16000);
    expect(rms(prepared.samples)).toBeCloseTo(0.3 / Math.sqrt(2), 3);
  });
  it.each([44100, 48000, 16000])(
    'resamples %i Hz to 16 kHz without shifting pitch or duration',
    (rate) => {
      const input = tone(rate);
      const output = resampleMono(input, rate);
      expect(output).toHaveLength(16000);
      expect(output).not.toBe(input);
      const expected = tone(16000);
      expect(
        rms(Float32Array.from(output.subarray(200, 15800), (v, i) => v - expected[i + 200])),
      ).toBeLessThan(0.001);
    },
  );
  it('removes above-Nyquist energy instead of aliasing it into speech', () => {
    expect(rms(resampleMono(tone(48000, 1, 11000), 48000).subarray(200, 15800))).toBeLessThan(
      0.001,
    );
  });
  it('rejects invalid resampling rates and non-finite PCM', () => {
    for (const rate of [0, -1, NaN, Infinity, 1])
      expect(() => resampleMono(tone(16000), rate)).toThrow(/rate/i);
    expect(() => resampleMono(Float32Array.of(NaN), 16000)).toThrow(/finite/i);
    expect(resampleMono(new Float32Array(), 48000)).toHaveLength(0);
  });
  it('rejects absent, mismatched or non-finite channels', () => {
    expect(() => downmixChannels([])).toThrow(/channel/i);
    expect(() => downmixChannels([new Float32Array(2), new Float32Array(1)])).toThrow(/length/i);
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => downmixChannels([Float32Array.of(value)])).toThrow(/finite/i);
    }
  });
  it('averages all channels without mutating their PCM', () => {
    const left = Float32Array.of(0.2, -0.8, 0.6);
    const right = Float32Array.of(0.6, 0.2, -0.4);
    expect(Array.from(downmixChannels([left, right]))).toEqual([
      expect.closeTo(0.4),
      expect.closeTo(-0.3),
      expect.closeTo(0.1),
    ]);
    expect(Array.from(left)).toEqual(Array.from(Float32Array.of(0.2, -0.8, 0.6)));
    expect(downmixChannels([left])).not.toBe(left);
  });
});
