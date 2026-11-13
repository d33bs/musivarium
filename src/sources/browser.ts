import * as zarr from 'zarrita';
import { ReadSession } from './read-session';
import type { Pixels, Region } from '../core';
import { parseNgff } from './metadata';
import type { Alignment, NgffMetadata, NetworkStats, PlaneRequest } from './metadata';
export * from './metadata';
export function selectionForRegion(
  axes: string[],
  shape: number[],
  r: PlaneRequest,
): (number | zarr.Slice)[] {
  if (axes.length !== shape.length) throw Error('Array rank does not match NGFF axes');
  for (const [name, index] of [
    ['z', r.z],
    ['t', r.t],
    ['c', r.channel],
  ] as const)
    if (!axes.includes(name) && index !== 0)
      throw Error(`${name} index out of bounds (axis absent)`);
  return axes.map((name, i) => {
    const start =
      name === 'x' ? r.x : name === 'y' ? r.y : name === 'z' ? r.z : name === 't' ? r.t : r.channel;
    const length = name === 'x' ? r.width : name === 'y' ? r.height : 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 0 ||
      length < 1 ||
      start + length > shape[i]
    )
      throw Error(`${name} selection out of bounds`);
    return name === 'x' || name === 'y' ? zarr.slice(start, start + length, 1) : start;
  });
}
export class BrowserSource {
  readonly stats: NetworkStats = { requests: 0, bytes: 0, cacheHits: 0, objects: [] };
  readonly metadata: NgffMetadata;
  private arrays = new Map<number, zarr.Array<any, zarr.FetchStore>>();
  private cache = new Map<string, Uint8Array>();
  private cacheBytes = 0;
  private constructor(
    readonly url: string,
    metadata: NgffMetadata,
    private signal: AbortSignal,
    private store: zarr.FetchStore,
    private session: ReadSession,
  ) {
    this.metadata = metadata;
  }
  static async open(
    url: string,
    signal: AbortSignal,
    session = new ReadSession(signal),
  ): Promise<BrowserSource> {
    signal = AbortSignal.any([signal, session.signal]);
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw Error('Source must use HTTP or HTTPS');
    u.pathname = u.pathname.replace(/\/*$/, '/');
    let source: BrowserSource | undefined;
    const initial: NetworkStats = { requests: 0, bytes: 0, cacheHits: 0, objects: [] };
    const cache = new Map<string, Uint8Array>();
    const store = new zarr.FetchStore(u, {
      fetch: async (request) => {
        signal.throwIfAborted();
        const stats = source?.stats ?? initial,
          key = request.url + '|' + (request.headers.get('range') ?? '');
        const hit = (source?.cache ?? cache).get(key);
        if (hit) {
          stats.cacheHits++;
          return new Response(hit.slice().buffer as ArrayBuffer, {
            status: request.headers.has('range') ? 206 : 200,
          });
        }
        const response = await session.request(request, (attempt) => {
          stats.requests++;
          stats.bytes += attempt.bytes;
          stats.fetch_ms = (stats.fetch_ms ?? 0) + attempt.milliseconds;
          stats.objects.push(attempt);
        });
        const body = new Uint8Array(await response.arrayBuffer());
        if (stats.bytes > 96 * 1024 * 1024)
          throw Error('Network budget exceeded (96 MiB); use fewer or smaller tiles');
        if (response.ok) {
          const map = source?.cache ?? cache;
          if (source) {
            while (source.cacheBytes + body.byteLength > 24 * 1024 * 1024 && map.size) {
              const first = map.keys().next().value!;
              source.cacheBytes -= map.get(first)!.byteLength;
              map.delete(first);
            }
            if (body.byteLength <= 24 * 1024 * 1024) {
              map.set(key, body);
              source.cacheBytes += body.byteLength;
            }
          } else cache.set(key, body);
        }
        return new Response(body.buffer as ArrayBuffer, {
          status: response.status,
          headers: response.headers,
        });
      },
    });
    try {
      const group = await zarr.open(store, { kind: 'group' });
      source = new BrowserSource(u.href, parseNgff(group.attrs), signal, store, session);
      Object.assign(source.stats, initial);
      source.cache = cache;
      source.cacheBytes = [...cache.values()].reduce((n, b) => n + b.byteLength, 0);
      return source;
    } catch (e) {
      if (signal.aborted) throw e;
      throw Error(
        `Cannot open OME-Zarr image. Check the image-group URL, CORS, codecs and network: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  async level(index: number) {
    this.signal.throwIfAborted();
    if (!this.metadata.levels[index]) throw Error('Resolution level out of bounds');
    let a = this.arrays.get(index);
    if (!a) {
      const path = this.metadata.levels[index].path;
      if (path.startsWith('/') || path.split('/').includes('..'))
        throw Error('Unsafe NGFF dataset path');
      a = await zarr.open(zarr.root(this.store).resolve(path), { kind: 'array' });
      if (!['uint8', 'uint16', 'int16', 'uint32', 'int32', 'float32', 'float64'].includes(a.dtype))
        throw Error(`Unsupported native image dtype ${a.dtype}`);
      this.arrays.set(index, a);
    }
    if (a.shape.length !== this.metadata.axes.length) throw Error('Array rank does not match axes');
    return a;
  }
  async alignment(level: number): Promise<Alignment> {
    const a = await this.level(level),
      l = this.metadata.levels[level];
    return {
      axes: this.metadata.axes.map((a) => a.name),
      shape: [...a.shape],
      scale: l.scale,
      translation: l.translation,
    };
  }
  async readRegion(level: number, request: PlaneRequest): Promise<Pixels> {
    const a = await this.level(level),
      axes = this.metadata.axes.map((a) => a.name),
      selection = selectionForRegion(axes, a.shape, request);
    for (const axis of ['z', 't']) {
      const index = axes.indexOf(axis);
      if (index >= 0 && a.chunks[index] > 1)
        throw Error(
          `Unsupported ${axis}-chunk depth ${a.chunks[index]}: this single-plane explorer requires one ${axis} index per chunk`,
        );
    }
    if (request.width * request.height > 512 * 512)
      throw Error('ROI exceeds the 512 × 512 pixel limit');
    const bytes = Number(a.dtype.match(/\d+/)?.[0] ?? 64) / 8;
    let decoded = bytes;
    for (let i = 0; i < a.shape.length; i++) {
      const sel = selection[i],
        start = typeof sel === 'number' ? sel : (sel.start ?? 0),
        stop = typeof sel === 'number' ? sel + 1 : sel.stop!;
      decoded *=
        a.chunks[i] * (Math.floor((stop - 1) / a.chunks[i]) - Math.floor(start / a.chunks[i]) + 1);
    }
    if (decoded > 64 * 1024 * 1024)
      throw Error(
        'Selected chunks exceed the 64 MiB decoded-read budget. Choose smaller tiles or another level.',
      );
    const releaseDecoded = await this.session.reserveDecoded(decoded);
    try {
      this.stats.decoded_bytes = (this.stats.decoded_bytes ?? 0) + decoded;
      const decodeStart = performance.now(),
        firstAttempt = this.stats.objects.length;
      const result = await zarr.get(a, selection, {
        signal: this.signal,
        createQueue: () => {
          const jobs: (() => Promise<void>)[] = [];
          return {
            add: (fn: () => Promise<void>) => jobs.push(fn),
            onIdle: async () => {
              let i = 0;
              return await Promise.all(
                Array.from({ length: Math.min(4, jobs.length) }, async () => {
                  while (i < jobs.length) await jobs[i++]();
                }),
              );
            },
          };
        },
      });
      if (typeof result !== 'object' || !('data' in result)) throw Error('Expected a 2D plane');
      const data = result.data as Pixels,
        out = new (data.constructor as { new (n: number): Pixels })(request.width * request.height),
        remaining = axes.filter((n) => n === 'x' || n === 'y'),
        xi = remaining.indexOf('x'),
        yi = remaining.indexOf('y');
      for (let y = 0; y < request.height; y++)
        for (let x = 0; x < request.width; x++)
          out[y * request.width + x] = Number(data[y * result.stride[yi] + x * result.stride[xi]]);
      const end = performance.now(),
        intervals = this.stats.objects
          .slice(firstAttempt)
          .filter((a) => a.started_at_ms !== undefined)
          .map((a) => [
            Math.max(decodeStart, a.started_at_ms!),
            Math.min(end, a.started_at_ms! + (a.milliseconds ?? 0)),
          ])
          .sort((a, b) => a[0] - b[0]);
      let network = 0,
        last = decodeStart;
      for (const [start, stop] of intervals) {
        network += Math.max(0, stop - Math.max(last, start));
        last = Math.max(last, stop);
      }
      this.stats.decode_copy_ms =
        (this.stats.decode_copy_ms ?? 0) + Math.max(0, end - decodeStart - network);
      this.signal.throwIfAborted();
      return out;
    } finally {
      releaseDecoded();
    }
  }
}
