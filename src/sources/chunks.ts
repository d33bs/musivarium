import type { Pixels } from '../core';
import type { PlaneRequest } from './metadata';
export const nativeTypes = {
  uint8: Uint8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
};
export type NativeType = keyof typeof nativeTypes;
export interface ArrayInfo {
  shape: number[];
  chunks: number[];
  dtype: NativeType;
  bytes: number;
  codecs: Record<string, any>[];
  fill: unknown;
  key: (indices: number[]) => string;
}
/** Only codec metadata is adapted; compressed source chunk bytes are never rewritten. */
export function arrayInfo(raw: Record<string, any>): ArrayInfo {
  let dtype: string,
    chunks: number[],
    codecs: Record<string, any>[],
    key: (indices: number[]) => string;
  if (raw.zarr_format === 2) {
    const match = /^([<>|])([uif])(1|2|4|8)$/.exec(raw.dtype);
    if (!match) throw Error(`Unsupported native image dtype ${raw.dtype}`);
    dtype = { u: 'uint', i: 'int', f: 'float' }[match[2]]! + Number(match[3]) * 8;
    if (raw.order !== 'C' || raw.filters?.length)
      throw Error('Unsupported Zarr v2 array order or filters');
    chunks = raw.chunks;
    codecs = [{ name: 'bytes', configuration: { endian: match[1] === '>' ? 'big' : 'little' } }];
    const c = raw.compressor;
    if (c) {
      if (c.id === 'blosc')
        codecs.push({
          name: 'blosc',
          configuration: {
            typesize: Number(match[3]),
            cname: c.cname,
            clevel: c.clevel,
            blocksize: c.blocksize ?? 0,
            shuffle: ['noshuffle', 'shuffle', 'bitshuffle'][c.shuffle],
          },
        });
      else if (c.id === 'gzip' || c.id === 'zstd') {
        const { id, ...configuration } = c;
        codecs.push({ name: id, configuration });
      } else throw Error(`Unsupported Zarr v2 compressor ${c.id}`);
    }
    const separator = raw.dimension_separator ?? '.';
    if (!['.', '/'].includes(separator)) throw Error('Unsupported chunk separator');
    key = (indices) => indices.join(separator);
  } else if (raw.zarr_format === 3 && raw.node_type === 'array') {
    if (raw.storage_transformers?.length) throw Error('Unsupported Zarr storage transformers');
    dtype = raw.data_type;
    chunks = raw.chunk_grid?.configuration?.chunk_shape;
    if (raw.chunk_grid?.name !== 'regular') throw Error('Unsupported Zarr chunk grid');
    codecs = structuredClone(raw.codecs);
    if (
      !Array.isArray(codecs) ||
      codecs.some(
        (c) => !['bytes', 'blosc', 'gzip', 'zstd', 'crc32c', 'transpose'].includes(c.name),
      )
    )
      throw Error('Unsupported Zarr v3 codec pipeline (sharded arrays are not enabled)');
    const encoding = raw.chunk_key_encoding ?? {
      name: 'default',
      configuration: { separator: '/' },
    };
    const separator = encoding.configuration?.separator ?? (encoding.name === 'v2' ? '.' : '/');
    if (!['.', '/'].includes(separator) || !['default', 'v2'].includes(encoding.name))
      throw Error('Unsupported chunk key encoding');
    key = (indices) =>
      encoding.name === 'default' ? ['c', ...indices].join(separator) : indices.join(separator);
  } else throw Error('Expected Zarr v2 or v3 array metadata');
  if (!Object.hasOwn(nativeTypes, dtype)) throw Error(`Unsupported native image dtype ${dtype}`);
  const shape = raw.shape;
  if (
    !Array.isArray(shape) ||
    !Array.isArray(chunks) ||
    shape.length !== chunks.length ||
    !shape.length ||
    [...shape, ...chunks].some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    throw Error('Invalid Zarr shape/chunks');
  return {
    shape: [...shape],
    chunks: [...chunks],
    dtype: dtype as NativeType,
    bytes: nativeTypes[dtype as NativeType].BYTES_PER_ELEMENT,
    codecs,
    fill: raw.fill_value ?? 0,
    key,
  };
}
export interface ChunkPlan {
  key: string;
  indices: number[];
  origin: number[];
}
export function planChunks(info: ArrayInfo, axes: string[], r: PlaneRequest): ChunkPlan[] {
  if (
    axes.length !== info.shape.length ||
    new Set(axes).size !== axes.length ||
    !axes.includes('x') ||
    !axes.includes('y')
  )
    throw Error('Array rank does not match NGFF axes');
  for (const axis of ['t', 'z', 'c'] as const)
    if (!axes.includes(axis) && (axis === 'c' ? r.channel : r[axis]) !== 0)
      throw Error(`${axis} selection out of bounds (axis absent)`);
  const ranges = axes.map((axis, i) => {
    if (!['t', 'c', 'z', 'y', 'x'].includes(axis)) throw Error('Unsupported axes');
    const start =
      axis === 'x' ? r.x : axis === 'y' ? r.y : axis === 'c' ? r.channel : r[axis as 't' | 'z'];
    const length = axis === 'x' ? r.width : axis === 'y' ? r.height : 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 0 ||
      length < 1 ||
      start + length > info.shape[i]
    )
      throw Error(`${axis} selection out of bounds`);
    if (['z', 't'].includes(axis) && info.chunks[i] > 1)
      throw Error(
        `Unsupported ${axis}-chunk depth ${info.chunks[i]}: requires one ${axis} index per chunk`,
      );
    return [Math.floor(start / info.chunks[i]), Math.floor((start + length - 1) / info.chunks[i])];
  });
  if (r.width * r.height > 512 * 512) throw Error('ROI exceeds the 512 × 512 pixel limit');
  const count = ranges.reduce((n, [a, b]) => n * (b - a + 1), 1),
    decoded = info.chunks.reduce((n, d) => n * d, info.bytes) * count;
  if (!Number.isSafeInteger(decoded) || decoded > 64 * 1024 * 1024 || count > 1024)
    throw Error('Selected chunks exceed the 64 MiB decoded-read budget');
  const result: ChunkPlan[] = [];
  const visit = (indices: number[]) => {
    if (indices.length === axes.length) {
      result.push({
        key: info.key(indices),
        indices,
        origin: indices.map((n, i) => n * info.chunks[i]),
      });
      return;
    }
    const [a, b] = ranges[indices.length];
    for (let i = a; i <= b; i++) visit([...indices, i]);
  };
  visit([]);
  return result;
}
/** A complete derived single-chunk Zarr view, never a sparse original-size volume. */
export function chunkView(info: ArrayInfo, axes: string[]) {
  return {
    zarr_format: 3,
    node_type: 'array',
    shape: [...info.chunks],
    data_type: info.dtype,
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [...info.chunks] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: info.fill,
    codecs: structuredClone(info.codecs),
    dimension_names: [...axes],
    attributes: {},
  };
}
export function allocate(info: ArrayInfo, length: number): Pixels {
  return new nativeTypes[info.dtype](length);
}
