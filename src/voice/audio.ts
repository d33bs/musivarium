export const VOICE_SAMPLE_RATE = 16000 as const;

export interface PreparedAudio {
  samples: Float32Array;
  sampleRate: 16000;
  durationSeconds: number;
  warnings: string[];
}

export const MAX_RECORDING_SECONDS = 90;
export const MIN_RECORDING_SECONDS = 0.25;

/** Validate in memory, downmix, anti-alias and prepare ASR input. No persistence. */
export function prepareAudio(channels: readonly Float32Array[], sourceRate: number): PreparedAudio {
  checkRate(sourceRate);
  const length = channels[0]?.length ?? 0;
  if (!length) throw new Error('Recording is empty. Please record some speech.');
  const duration = length / sourceRate;
  if (duration > MAX_RECORDING_SECONDS) throw new Error('Recording exceeds the 90-second limit.');
  if (duration < MIN_RECORDING_SECONDS)
    throw new Error('Recording is too short. Please record at least 0.25 seconds.');
  const mono = downmixChannels(channels);
  const samples = resampleMono(mono, sourceRate);
  let sum = 0;
  let squares = 0;
  let clipped = 0;
  const edge = Math.min(160, Math.floor(samples.length / 10));
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    if (i >= edge && i < samples.length - edge) {
      sum += value;
      squares += value * value;
    }
    samples[i] = Math.max(-1, Math.min(1, value));
  }
  for (const channel of channels) {
    for (const value of channel) if (Math.abs(value) >= 0.995) clipped++;
  }
  const count = samples.length - 2 * edge;
  const energy = Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2));
  if (energy < 0.0001)
    throw new Error('Recording is silent or contains no usable speech. Check your microphone.');
  const warnings: string[] = [];
  if (energy < 0.01) warnings.push('Recording is quiet; speech recognition may be inaccurate.');
  if (clipped / (length * channels.length) >= 0.001)
    warnings.push('Recording is clipped; speak farther from the microphone.');
  return {
    samples,
    sampleRate: VOICE_SAMPLE_RATE,
    durationSeconds: samples.length / VOICE_SAMPLE_RATE,
    warnings,
  };
}

/** Playable in-memory PCM16 WAV for preview; caller owns/revokes any object URL. */
export function wavBlob(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + 2 * samples.length);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw new Error('Audio must contain only finite samples.');
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function checkRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 8000 || rate > 384000) {
    throw new Error('Unsupported audio sample rate.');
  }
}

/** Pure, band-limited windowed-sinc conversion to 16-kHz mono PCM. */
export function resampleMono(samples: Float32Array, sourceRate: number): Float32Array {
  checkRate(sourceRate);
  for (const value of samples) {
    if (!Number.isFinite(value)) throw new Error('Audio must contain only finite samples.');
  }
  if (sourceRate === VOICE_SAMPLE_RATE) return samples.slice();
  const ratio = VOICE_SAMPLE_RATE / sourceRate;
  const result = new Float32Array(Math.round(samples.length * ratio));
  const cutoff = Math.min(1, ratio) * 0.94;
  const radius = Math.ceil(24 / Math.min(1, ratio));
  // Quantized fractional phases avoid trigonometry per output sample. The
  // Blackman window suppresses aliases; normalization preserves DC at edges.
  const phases = 1024;
  const kernels = Array.from({ length: phases }, (_, phase) => {
    const kernel = new Float64Array(2 * radius + 1);
    for (let tap = -radius; tap <= radius; tap++) {
      const x = tap - phase / phases;
      if (Math.abs(x) > radius) continue;
      const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
      kernel[tap + radius] =
        sinc *
        (0.42 +
          0.5 * Math.cos((Math.PI * x) / radius) +
          0.08 * Math.cos((2 * Math.PI * x) / radius));
    }
    return kernel;
  });
  for (let i = 0; i < result.length; i++) {
    const position = i / ratio;
    const center = Math.floor(position);
    const kernel = kernels[Math.floor((position - center) * phases)];
    let sum = 0;
    let weight = 0;
    for (
      let tap = Math.max(-radius, -center);
      tap <= Math.min(radius, samples.length - 1 - center);
      tap++
    ) {
      const w = kernel[tap + radius];
      sum += samples[center + tap] * w;
      weight += w;
    }
    result[i] = weight ? sum / weight : 0;
  }
  return result;
}

/** Arithmetic mean downmix. Returns owned mono PCM; never changes the input. */
export function downmixChannels(channels: readonly Float32Array[]): Float32Array {
  if (!channels.length) throw new Error('No audio channels were provided.');
  const result = new Float32Array(channels[0].length);
  for (const channel of channels) {
    if (channel.length !== result.length) throw new Error('Audio channel lengths differ.');
    for (let i = 0; i < result.length; i++) {
      if (!Number.isFinite(channel[i])) throw new Error('Audio must contain only finite samples.');
      result[i] += channel[i] / channels.length;
    }
  }
  return result;
}
