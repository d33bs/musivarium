import type { Region } from '../core';
export interface Axis {
  name: string;
  type?: string;
  unit?: string;
}
export interface Level {
  path: string;
  scale: number[];
  translation: number[];
}
export interface Channel {
  name: string;
  color: string;
}
export interface NgffMetadata {
  axes: Axis[];
  levels: Level[];
  channels: Channel[];
  labels: string[];
  version: string;
}
export interface PlaneRequest extends Region {
  z: number;
  t: number;
  channel: number;
}
export interface Alignment {
  axes: string[];
  shape: number[];
  scale: number[];
  translation: number[];
}
export interface NetworkStats {
  requests: number;
  bytes: number;
  cacheHits: number;
  objects: {
    url: string;
    bytes: number;
    status: number;
    milliseconds?: number;
    started_at_ms?: number;
    error?: string;
  }[];
  fetch_ms?: number;
  decoded_bytes?: number;
  decode_copy_ms?: number;
  decoding_backend?: 'duckdb-zarr';
  chunk_views?: {
    original_chunk_url: string;
    original_shape: number[];
    chunk_origin: number[];
    wrapper_metadata: Record<string, unknown>;
    sql: string;
    rows: number;
  }[];
}
const asRecord = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' ? (v as Record<string, any>) : {};
export function parseNgff(attributes: unknown): NgffMetadata {
  const root = asRecord(attributes),
    data = asRecord(root.ome ?? root),
    multi = data.multiscales?.[0];
  if (!multi?.axes || !multi?.datasets?.length)
    throw Error(
      'Expected an OME-NGFF image group with axes and multiscales metadata (not an array or plate root)',
    );
  const axes: Axis[] = multi.axes.map((a: string | Axis) =>
    typeof a === 'string' ? { name: a } : a,
  );
  const names = axes.map((a) => a.name);
  if (
    !names.includes('x') ||
    !names.includes('y') ||
    new Set(names).size !== names.length ||
    names.some((n) => !['t', 'c', 'z', 'y', 'x'].includes(n))
  )
    throw Error('Unsupported axes: expected unique t, c, z, y, x axes');
  const levels: Level[] = multi.datasets.map((d: any) => {
    const scale = axes.map(() => 1),
      translation = axes.map(() => 0);
    for (const tr of [
      ...(d.coordinateTransformations ?? []),
      ...(multi.coordinateTransformations ?? []),
    ]) {
      if (tr.type === 'scale') {
        if (
          tr.scale?.length !== axes.length ||
          tr.scale.some((v: number) => !Number.isFinite(v) || v <= 0)
        )
          throw Error('Invalid scale transform');
        for (let i = 0; i < scale.length; i++) {
          scale[i] *= tr.scale[i];
          translation[i] *= tr.scale[i];
        }
      } else if (tr.type === 'translation') {
        if (
          tr.translation?.length !== axes.length ||
          tr.translation.some((v: number) => !Number.isFinite(v))
        )
          throw Error('Invalid translation transform');
        for (let i = 0; i < translation.length; i++) translation[i] += tr.translation[i];
      } else throw Error(`Unsupported coordinate transform ${tr.type}`);
    }
    return { path: d.path, scale, translation };
  });
  const channels =
    (data.omero ?? root.omero)?.channels?.map((c: any, i: number) => ({
      name: c.label ?? `Channel ${i}`,
      color: /^[0-9a-f]{6}$/i.test(c.color) ? c.color : 'FFFFFF',
    })) ?? [];
  return {
    axes,
    levels,
    channels,
    labels: data.labels ?? root.labels ?? [],
    version: data.version ?? multi.version ?? 'unknown',
  };
}
export function validateLabelAlignment(image: Alignment, label: Alignment): void {
  for (const name of ['t', 'z', 'y', 'x']) {
    const i = image.axes.indexOf(name),
      j = label.axes.indexOf(name);
    if (i < 0 && j < 0) continue;
    if (i < 0 || j < 0) {
      const o = i < 0 ? label : image,
        k = i < 0 ? j : i;
      if (o.shape[k] !== 1) throw Error(`Label raster does not align on ${name}`);
      continue;
    }
    if (
      image.shape[i] !== label.shape[j] ||
      Math.abs(image.scale[i] - label.scale[j]) > 1e-9 ||
      Math.abs(image.translation[i] - label.translation[j]) > 1e-9
    )
      throw Error(
        `Label raster does not align on ${name}; matching shape, scale and translation required`,
      );
  }
  const c = label.axes.indexOf('c');
  if (c >= 0 && label.shape[c] !== 1) throw Error('Label raster has ambiguous multiple channels');
}
