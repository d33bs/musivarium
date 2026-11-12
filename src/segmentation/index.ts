export type Pixels = Float32Array | Uint16Array | Uint8Array;
export interface SegmentationOptions {
  threshold?: number;
  minArea?: number;
}
export interface ModelOptions extends SegmentationOptions {
  signal?: AbortSignal;
  modelUrl?: string;
  /** For offline/test callers. Integrity is checked just like downloaded weights. */
  modelBytes?: Uint8Array;
}

export const MODEL_ID = 'stardist-dsb2018-90430209';

export const MODEL_INFO = Object.freeze({
  name: 'StarDist DSB2018',
  url: 'models/stardist-dsb2018.onnx',
  sha256: '90430209afef1fbcede0b1bbd78d37e0ed9edf59cc89ef6d894356e089a5ae36',
  bytes: 5891415,
  rays: 48,
  grid: 2,
});

function validate(pixels: Pixels, width: number, height: number, options: SegmentationOptions) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height !== pixels.length ||
    pixels.length > 16_777_216
  ) {
    throw new Error('Invalid image dimensions or pixel length (maximum 16 million pixels)');
  }
  if (
    options.minArea !== undefined &&
    (!Number.isSafeInteger(options.minArea) || options.minArea < 1)
  )
    throw new Error('minArea must be a positive integer');
  if (options.threshold !== undefined && !Number.isFinite(options.threshold))
    throw new Error('threshold must be finite');
  for (const pixel of pixels)
    if (!Number.isFinite(pixel)) throw new Error('All intensities must be finite');
}

function otsu(pixels: Pixels): number {
  let min = Infinity,
    max = -Infinity;
  for (const p of pixels) {
    min = Math.min(min, p);
    max = Math.max(max, p);
  }
  if (max === min) return max;
  const histogram = new Uint32Array(256);
  for (const p of pixels) histogram[Math.min(255, Math.floor(((p - min) / (max - min)) * 255))]!++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i]!;
  let background = 0,
    backgroundSum = 0,
    score = -1,
    threshold = 0;
  for (let i = 0; i < 256; i++) {
    background += histogram[i]!;
    if (background === 0) continue;
    const foreground = pixels.length - background;
    if (foreground === 0) break;
    backgroundSum += i * histogram[i]!;
    const delta = backgroundSum / background - (sum - backgroundSum) / foreground;
    const variance = background * foreground * delta * delta;
    if (variance > score) {
      score = variance;
      threshold = i;
    }
  }
  return min + (threshold / 255) * (max - min);
}

/** Bright foreground, Otsu (or raw intensity threshold), 8-connected components. */
export function segmentClassical(
  pixels: Pixels,
  width: number,
  height: number,
  options: SegmentationOptions = {},
): Uint32Array {
  validate(pixels, width, height, options);
  const threshold = options.threshold ?? otsu(pixels);
  const labels = new Uint32Array(pixels.length);
  const queue = new Uint32Array(pixels.length);
  const visited = new Uint8Array(pixels.length);
  let next = 0;
  for (let start = 0; start < pixels.length; start++) {
    if (visited[start] || pixels[start]! <= threshold) continue;
    let read = 0,
      size = 1;
    queue[0] = start;
    visited[start] = 1;
    while (read < size) {
      const i = queue[read++]!,
        x = i % width;
      const add = (j: number) => {
        if (!visited[j] && pixels[j]! > threshold) {
          visited[j] = 1;
          queue[size++] = j;
        }
      };
      if (x > 0) add(i - 1);
      if (x + 1 < width) add(i + 1);
      if (i >= width) {
        add(i - width);
        if (x > 0) add(i - width - 1);
        if (x + 1 < width) add(i - width + 1);
      }
      if (i + width < pixels.length) {
        add(i + width);
        if (x > 0) add(i + width - 1);
        if (x + 1 < width) add(i + width + 1);
      }
    }
    if (size < (options.minArea ?? 1)) continue;
    next++;
    for (let j = 0; j < size; j++) labels[queue[j]!] = next;
  }
  return labels;
}

/** csbdeep-style linear percentile normalization; no clipping or bit-depth conversion. */
export function normalizePercentile(pixels: Pixels): Float32Array {
  if (!pixels.length) return new Float32Array();
  const sorted = Float32Array.from(pixels).sort();
  const quantile = (q: number) => {
    const at = (sorted.length - 1) * q,
      low = Math.floor(at),
      high = Math.ceil(at);
    return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
  };
  const low = quantile(0.01),
    high = quantile(0.998);
  const scale = high - low + 1e-20;
  return Float32Array.from(pixels, (p) => (p - low) / scale);
}

/** Rasterized star polygons; greedy mask-IoU NMS (0.3), not upstream exact polygon NMS. */
export function decodeStarDist(
  data: Float32Array,
  gridWidth: number,
  gridHeight: number,
  width: number,
  height: number,
  options: SegmentationOptions = {},
): Uint32Array {
  const channels = data.length / (gridWidth * gridHeight),
    rays = channels - 1;
  if (!Number.isInteger(channels) || rays < 3) throw new Error('Invalid StarDist output shape');
  const threshold = options.threshold ?? 0.5;
  const candidates: { x: number; y: number; probability: number; offset: number }[] = [];
  for (let y = 0; y < gridHeight; y++)
    for (let x = 0; x < gridWidth; x++) {
      const offset = (y * gridWidth + x) * channels;
      if (Number.isFinite(data[offset]) && data[offset]! > threshold)
        candidates.push({ x: x * 2, y: y * 2, probability: data[offset]!, offset });
    }
  candidates.sort((a, b) => b.probability - a.probability || a.offset - b.offset);
  const labels = new Uint32Array(width * height);
  const areas: number[] = [0];
  let next = 0;
  // Bound pathological inputs: normal microscopy produces far fewer candidates.
  if (candidates.length > 65_536)
    throw new Error(
      'Too many model candidates; use a smaller crop or higher probability threshold',
    );
  for (const candidate of candidates) {
    const xs: number[] = [],
      ys: number[] = [];
    let valid = true;
    for (let ray = 0; ray < rays; ray++) {
      const distance = data[candidate.offset + ray + 1]!;
      if (!Number.isFinite(distance) || distance < 0 || distance > Math.max(width, height) * 4) {
        valid = false;
        break;
      }
      const angle = (ray * 2 * Math.PI) / rays;
      xs.push(candidate.x + distance * Math.cos(angle));
      ys.push(candidate.y + distance * Math.sin(angle));
    }
    if (!valid) continue;
    const minX = Math.max(0, Math.ceil(Math.min(...xs))),
      maxX = Math.min(width - 1, Math.floor(Math.max(...xs)));
    const minY = Math.max(0, Math.ceil(Math.min(...ys))),
      maxY = Math.min(height - 1, Math.floor(Math.max(...ys)));
    const indices: number[] = [];
    const intersections = new Map<number, number>();
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        let inside = false;
        for (let i = 0, j = rays - 1; i < rays; j = i++) {
          if (
            ys[i]! > y !== ys[j]! > y &&
            x < ((xs[j]! - xs[i]!) * (y - ys[i]!)) / (ys[j]! - ys[i]!) + xs[i]!
          )
            inside = !inside;
        }
        if (!inside) continue;
        const index = y * width + x;
        indices.push(index);
        const existing = labels[index]!;
        if (existing) intersections.set(existing, (intersections.get(existing) ?? 0) + 1);
      }
    if (indices.length < (options.minArea ?? 1)) continue;
    let suppress = false;
    for (const [id, overlap] of intersections)
      if (overlap / (indices.length + areas[id]! - overlap) > 0.3) {
        suppress = true;
        break;
      }
    if (suppress) continue;
    const free = indices.filter((index) => labels[index] === 0);
    if (free.length < (options.minArea ?? 1)) continue;
    next++;
    areas.push(free.length);
    for (const index of free) labels[index] = next;
  }
  return labels;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Segmentation cancelled', 'AbortError');
}

let sessionPromise: Promise<import('onnxruntime-web').InferenceSession> | undefined;
let sessionKey: string | undefined;

async function loadSession(options: ModelOptions) {
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.numThreads = 1; // portable CPU path, no COOP/COEP or GPU required
  ort.env.wasm.proxy = false;
  const assetBase =
    typeof location !== 'undefined'
      ? new URL(import.meta.env.DEV ? '../../' : '../', import.meta.url).href
      : undefined;
  if (assetBase) ort.env.wasm.wasmPaths = new URL('vendor/', assetBase).href;
  const url =
    options.modelUrl ?? (assetBase ? new URL(MODEL_INFO.url, assetBase).href : MODEL_INFO.url);
  const key = options.modelBytes ? 'provided-bytes' : url;
  // Provided bytes bypass the shared cache so each payload is independently verified.
  if (!sessionPromise || sessionKey !== key || options.modelBytes) {
    sessionKey = key;
    sessionPromise = (async () => {
      let bytes = options.modelBytes;
      if (!bytes) {
        const response = await fetch(url, { signal: options.signal });
        if (!response.ok || !response.body)
          throw new Error(
            `Model unavailable (HTTP ${response.status}); run node scripts/setup-model.mjs or select Classical`,
          );
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          length += item.value.length;
          if (length > MODEL_INFO.bytes) {
            await reader.cancel();
            throw new Error('Model exceeds pinned size');
          }
          chunks.push(item.value);
        }
        bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
      }
      if (bytes.length !== MODEL_INFO.bytes) throw new Error('Model size mismatch');
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))),
      ]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      if (hash !== MODEL_INFO.sha256) throw new Error('Model SHA-256 mismatch');
      checkAbort(options.signal);
      return ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })();
    sessionPromise.catch(() => {
      sessionPromise = undefined;
      sessionKey = undefined;
    });
  }
  return { ort, session: await sessionPromise };
}

/** Actual pretrained neural inference on CPU/WASM; failures never masquerade as model output. */
export async function segmentModel(
  pixels: Pixels,
  width: number,
  height: number,
  options: ModelOptions = {},
): Promise<Uint32Array> {
  checkAbort(options.signal);
  validate(pixels, width, height, options);
  if (width > 1024 || height > 1024)
    throw new Error('Model crop is limited to 1024 × 1024; select a smaller ROI');
  if (options.threshold !== undefined && (options.threshold < 0 || options.threshold > 1))
    throw new Error('Model threshold must be a probability in [0, 1]');
  const normalized = normalizePercentile(pixels);
  // U-Net has three pooling stages. Edge pad to a multiple of 16, retaining original pixel scale.
  const paddedWidth = Math.max(16, Math.ceil(width / 16) * 16),
    paddedHeight = Math.max(16, Math.ceil(height / 16) * 16);
  const input = new Float32Array(paddedWidth * paddedHeight);
  for (let y = 0; y < paddedHeight; y++)
    for (let x = 0; x < paddedWidth; x++)
      input[y * paddedWidth + x] =
        normalized[Math.min(y, height - 1) * width + Math.min(x, width - 1)]!;
  const { ort, session } = await loadSession(options);
  checkAbort(options.signal);
  const tensor = new ort.Tensor('float32', input, [1, paddedHeight, paddedWidth, 1]);
  const outputs = await session.run({ keras_tensor: tensor });
  try {
    checkAbort(options.signal);
    const prob = outputs.prob,
      dist = outputs.dist;
    if (
      !prob ||
      !dist ||
      prob.dims[1] !== paddedHeight / 2 ||
      prob.dims[2] !== paddedWidth / 2 ||
      dist.dims[3] !== MODEL_INFO.rays
    )
      throw new Error('Unexpected StarDist output shape');
    const count = (paddedWidth / 2) * (paddedHeight / 2);
    const packed = new Float32Array(count * (MODEL_INFO.rays + 1));
    const probabilities = prob.data as Float32Array,
      distances = dist.data as Float32Array;
    for (let i = 0; i < count; i++) {
      packed[i * 49] = probabilities[i]!;
      packed.set(distances.subarray(i * 48, (i + 1) * 48), i * 49 + 1);
    }
    const labels = decodeStarDist(
      packed,
      paddedWidth / 2,
      paddedHeight / 2,
      width,
      height,
      options,
    );
    checkAbort(options.signal);
    return labels;
  } finally {
    tensor.dispose();
    for (const output of Object.values(outputs)) output.dispose();
  }
}
