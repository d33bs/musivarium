export type Pixels =
  Uint8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ObjectMeasurement extends Region {
  label: number;
  area: number;
  cx: number;
  cy: number;
  edge: boolean;
  means: number[];
}
export interface Crop extends Region {
  channels: Pixels[];
}
export type ReaderBackend = 'browser' | 'duckdb-zarr';
export type SegmentBackend = 'labels' | 'model' | 'classical';
export interface Settings {
  source: string;
  reader: ReaderBackend;
  segmentation: SegmentBackend;
  labelPath: string;
  level: number;
  t: number;
  z: number;
  channels: number[];
  segmentChannel: number;
  tile: number;
  count: number;
  seed: string;
  minArea: number;
  maxArea: number;
  excludeEdges: boolean;
  padding: number;
  target: number;
  modelThreshold: number;
  classicalThreshold: string;
  cropSize: number;
  manifestVersion: string;
  samplerVersion: string;
  modelVersion: string;
}
export const DEFAULT_SETTINGS: Settings = {
  source: 'https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/',
  reader: 'browser',
  segmentation: 'labels',
  labelPath: '0',
  level: 0,
  t: 0,
  z: 0,
  channels: [42],
  segmentChannel: 42,
  tile: 512,
  count: 4,
  seed: '42',
  minArea: 20,
  maxArea: 10000,
  excludeEdges: true,
  padding: 8,
  target: 100,
  modelThreshold: 0.5,
  classicalThreshold: '',
  cropSize: 32,
  manifestVersion: '1',
  samplerVersion: 'partition-v1',
  modelVersion: 'stardist-dsb2018-90430209',
};
export function random(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Deterministically sample a partition, without overlap or replacement. */
export function sampleWindows(
  width: number,
  height: number,
  tile: number,
  count: number,
  seed: string,
): Region[] {
  if (![width, height, tile, count].every((v) => Number.isSafeInteger(v) && v > 0))
    throw Error('Sampling dimensions must be positive integers');
  const nx = Math.ceil(width / tile),
    ny = Math.ceil(height / tile),
    n = nx * ny;
  if (count > n) throw Error(`Requested ${count} tiles but only ${n} available`);
  const rng = random(seed),
    swaps = new Map<number, number>(),
    result: Region[] = [];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (n - i)),
      k = swaps.get(j) ?? j;
    swaps.set(j, swaps.get(i) ?? i);
    const x = (k % nx) * tile,
      y = Math.floor(k / nx) * tile;
    result.push({ x, y, width: Math.min(tile, width - x), height: Math.min(tile, height - y) });
  }
  return result;
}
/** Measurements are on the native single-plane intensity arrays, never RGB previews. */
export function extractObjects(
  labels: Uint32Array,
  channels: Pixels[],
  width: number,
  height: number,
  origin: { x: number; y: number },
): ObjectMeasurement[] {
  if (labels.length !== width * height || channels.some((p) => p.length !== labels.length))
    throw Error('Plane dimensions do not match');
  const objects = new Map<
    number,
    {
      label: number;
      area: number;
      sx: number;
      sy: number;
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
      edge: boolean;
      sums: number[];
    }
  >();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label) continue;
    const x = i % width,
      y = Math.floor(i / width);
    let o = objects.get(label);
    if (!o) {
      o = {
        label,
        area: 0,
        sx: 0,
        sy: 0,
        minX: x,
        maxX: x,
        minY: y,
        maxY: y,
        edge: false,
        sums: channels.map(() => 0),
      };
      objects.set(label, o);
    }
    o.area++;
    o.sx += x;
    o.sy += y;
    o.minX = Math.min(o.minX, x);
    o.maxX = Math.max(o.maxX, x);
    o.minY = Math.min(o.minY, y);
    o.maxY = Math.max(o.maxY, y);
    o.edge ||= x === 0 || y === 0 || x === width - 1 || y === height - 1;
    for (let c = 0; c < channels.length; c++) o.sums[c] += Number(channels[c][i]);
  }
  return [...objects.values()]
    .sort((a, b) => a.label - b.label)
    .map((o) => ({
      label: o.label,
      area: o.area,
      cx: origin.x + o.sx / o.area,
      cy: origin.y + o.sy / o.area,
      x: origin.x + o.minX,
      y: origin.y + o.minY,
      width: o.maxX - o.minX + 1,
      height: o.maxY - o.minY + 1,
      edge: o.edge,
      means: o.sums.map((v) => v / o.area),
    }));
}
export function cropObject(
  channels: Pixels[],
  width: number,
  height: number,
  object: Region,
  origin: { x: number; y: number },
  padding: number,
  minSize = 0,
): Crop {
  const side = Math.max(minSize, object.width + 2 * padding, object.height + 2 * padding),
    cx = object.x - origin.x + object.width / 2,
    cy = object.y - origin.y + object.height / 2,
    x = Math.max(0, Math.floor(cx - side / 2)),
    y = Math.max(0, Math.floor(cy - side / 2)),
    right = Math.min(width, Math.floor(cx - side / 2) + side),
    bottom = Math.min(height, Math.floor(cy - side / 2) + side),
    w = right - x,
    h = bottom - y;
  const crops = channels.map((p) => {
    const q = new (p.constructor as { new (n: number): Pixels })(w * h);
    for (let row = 0; row < h; row++)
      q.set(p.subarray((y + row) * width + x, (y + row) * width + right), row * w);
    return q;
  });
  return { x: origin.x + x, y: origin.y + y, width: w, height: h, channels: crops };
}
export function normalize(pixels: Pixels, low: number, high: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  if (high <= low) return out;
  for (let i = 0; i < pixels.length; i++)
    out[i] = Math.round(
      Math.max(0, Math.min(255, ((Number(pixels[i]) - low) * 255) / (high - low))),
    );
  return out;
}
export function contrastLimits(pixels: Pixels): [number, number] {
  const values = Array.from(pixels)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!values.length) return [0, 1];
  return [
    values[Math.floor((values.length - 1) * 0.01)],
    values[Math.floor((values.length - 1) * 0.995)],
  ];
}
export function validateSettings(s: Settings): Settings {
  const url = new URL(s.source);
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Source must use HTTP or HTTPS');
  for (const key of [
    'level',
    't',
    'z',
    'segmentChannel',
    'padding',
    'minArea',
    'maxArea',
  ] as const) {
    if (!Number.isSafeInteger(s[key]) || s[key] < 0) throw Error(`Invalid ${key}`);
  }
  if (!['browser', 'duckdb-zarr'].includes(s.reader)) throw Error('Invalid reader');
  if (!['labels', 'model', 'classical'].includes(s.segmentation))
    throw Error('Invalid segmentation');
  if (!Number.isSafeInteger(s.count) || s.count < 1 || s.count > 32)
    throw Error('Tile count must be between 1 and 32');
  if (![128, 256, 512].includes(s.tile)) throw Error('Tile size must be 128, 256 or 512');
  if (!Number.isSafeInteger(s.target) || s.target < 1 || s.target > 1000)
    throw Error('Target count must be between 1 and 1000');
  if (!Number.isSafeInteger(s.cropSize) || s.cropSize < 8 || s.cropSize > 256)
    throw Error('Crop size must be 8–256 pixels');
  if (!Number.isFinite(s.modelThreshold) || s.modelThreshold < 0 || s.modelThreshold > 1)
    throw Error('Invalid model probability');
  if (s.classicalThreshold !== '' && !Number.isFinite(Number(s.classicalThreshold)))
    throw Error('Invalid classical threshold');
  if (
    s.manifestVersion !== '1' ||
    s.samplerVersion !== 'partition-v1' ||
    s.modelVersion !== 'stardist-dsb2018-90430209'
  )
    throw Error('This link uses an unsupported manifest, sampler or model version');
  if (s.padding > 64 || s.maxArea < s.minArea) throw Error('Invalid area or padding limits');
  if (
    s.channels.length < 1 ||
    s.channels.length > 4 ||
    s.channels.some((v) => !Number.isSafeInteger(v) || v < 0) ||
    new Set(s.channels).size !== s.channels.length
  )
    throw Error('Choose 1–4 unique channel indices');
  if (!s.channels.includes(s.segmentChannel))
    throw Error('Segmentation channel must be selected for display');
  if (s.seed.length > 128 || s.labelPath.length > 2048) throw Error('Seed or label path too long');
  return s;
}
export function parseSettings(href: string): Settings {
  const p = new URL(href).searchParams,
    s: Settings = { ...DEFAULT_SETTINGS, channels: [...DEFAULT_SETTINGS.channels] };
  for (const key of Object.keys(s) as (keyof Settings)[]) {
    if (!p.has(key)) continue;
    const value = p.get(key)!;
    if (key === 'channels') s.channels = value.split(',').map(Number);
    else if (typeof s[key] === 'number')
      (s as unknown as Record<string, unknown>)[key] = Number(value);
    else if (typeof s[key] === 'boolean')
      (s as unknown as Record<string, unknown>)[key] = value === 'true';
    else (s as unknown as Record<string, unknown>)[key] = value;
  }
  return validateSettings(s);
}
export function settingsUrl(settings: Settings, base: string): string {
  const u = new URL(base);
  u.search = '';
  u.hash = '';
  for (const [k, v] of Object.entries(settings))
    u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  return u.toString();
}
