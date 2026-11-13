import { ReadSession } from './read-session';
import {
  parseNgff,
  type NgffMetadata,
  type NetworkStats,
  type Alignment,
  type PlaneRequest,
} from './metadata';
import {
  arrayInfo,
  planChunks,
  chunkView,
  allocate,
  type ArrayInfo,
  type ChunkPlan,
} from './chunks';
import type { Pixels } from '../core';
export const DUCKDB_ZARR_AUDIT = Object.freeze({
  repository: 'xqlsystems/duckdb-zarr',
  distribution: 'community-extensions.duckdb.org',
  runtimePackage: '@duckdb/duckdb-wasm@1.33.1-dev114.0',
  engineVersion: 'v2.0.0',
  sha256: 'b28752c96e613b74a5575a7f0115d8084820f1c6a99c7f6f729e6babe34a465a',
  license: 'Apache-2.0',
  mode: 'bounded-complete-chunk-views',
});
// Registration/query/disposal are one transaction across parallel readers.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => {}).then(work);
  queue = next;
  return next;
}
export class DuckDBZarrSource {
  readonly backend = 'duckdb-zarr' as const;
  readonly stats: NetworkStats = {
    requests: 0,
    bytes: 0,
    cacheHits: 0,
    objects: [],
    decoding_backend: 'duckdb-zarr',
    chunk_views: [],
  };
  private arrays = new Map<number, Promise<ArrayInfo>>();
  private cache = new Map<string, Uint8Array>();
  private pending = new Map<string, Promise<Uint8Array | undefined>>();
  private cacheBytes = 0;
  private constructor(
    readonly url: string,
    readonly metadata: NgffMetadata,
    private signal: AbortSignal,
    private session: ReadSession,
  ) {}
  static async open(url: string, signal: AbortSignal, session = new ReadSession(signal)) {
    signal = AbortSignal.any([signal, session.signal]);
    signal.throwIfAborted();
    const u = new URL(url);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)
      throw Error('Source must use HTTP or HTTPS without embedded credentials');
    u.pathname = u.pathname.replace(/\/*$/, '/');
    const source = new DuckDBZarrSource(u.href, {} as NgffMetadata, signal, session);
    try {
      const v2 = await source.object('.zgroup', true);
      let attrs;
      if (v2) {
        const group = JSON.parse(new TextDecoder().decode(v2));
        if (group.zarr_format !== 2) throw Error('Expected a Zarr v2 group');
        attrs = await source.json('.zattrs');
      } else {
        const group = await source.json('zarr.json');
        if (group.node_type !== 'group')
          throw Error('Expected an OME-NGFF image group, not an array');
        attrs = group.attributes;
      }
      Object.assign(source.metadata, parseNgff(attrs));
      return source;
    } catch (e) {
      if (signal.aborted) throw e;
      throw Error(
        `Cannot open OME-Zarr image. Check metadata, URL, CORS and network: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  private async object(key: string, optional = false): Promise<Uint8Array | undefined> {
    this.signal.throwIfAborted();
    const url = new URL(key, this.url).href;
    const hit = this.cache.get(url);
    if (hit) {
      this.stats.cacheHits++;
      return hit;
    }
    const pending = this.pending.get(url);
    if (pending) {
      this.stats.cacheHits++;
      return pending;
    }
    const task = (async () => {
      const response = await this.session.request(new Request(url), (attempt) => {
        this.stats.requests++;
        this.stats.bytes += attempt.bytes;
        this.stats.fetch_ms = (this.stats.fetch_ms ?? 0) + attempt.milliseconds;
        this.stats.objects.push(attempt);
      });
      if (response.status === 404 && optional) return undefined;
      if (!response.ok)
        throw Error(`HTTP ${response.status} reading original source object ${url}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      while (this.cacheBytes + bytes.byteLength > 24 * 1024 * 1024 && this.cache.size) {
        const first = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(first)!.byteLength;
        this.cache.delete(first);
      }
      if (bytes.byteLength <= 24 * 1024 * 1024) {
        this.cache.set(url, bytes);
        this.cacheBytes += bytes.byteLength;
      }
      return bytes;
    })();
    this.pending.set(url, task);
    try {
      return await task;
    } finally {
      this.pending.delete(url);
    }
  }
  private async json(key: string) {
    const body = await this.object(key);
    return JSON.parse(new TextDecoder().decode(body));
  }
  async level(index: number): Promise<ArrayInfo> {
    this.signal.throwIfAborted();
    const level = this.metadata.levels[index];
    if (!level) throw Error('Resolution level out of bounds');
    let promise = this.arrays.get(index);
    if (!promise) {
      promise = (async () => {
        const path = level.path;
        if (
          !path ||
          path.startsWith('/') ||
          path.includes('\\') ||
          path.split('/').some((p) => !p || p === '..' || p === '.') ||
          /[?#:]/.test(path)
        )
          throw Error('Unsafe NGFF dataset path');
        const v2 = await this.object(path + '/.zarray', true);
        const info = arrayInfo(
          v2 ? JSON.parse(new TextDecoder().decode(v2)) : await this.json(path + '/zarr.json'),
        );
        if (info.shape.length !== this.metadata.axes.length)
          throw Error('Array rank does not match axes');
        return info;
      })();
      this.arrays.set(index, promise);
    }
    return promise;
  }
  async alignment(level: number): Promise<Alignment> {
    const a = await this.level(level),
      l = this.metadata.levels[level];
    return {
      axes: this.metadata.axes.map((a) => a.name),
      shape: [...a.shape],
      scale: [...l.scale],
      translation: [...l.translation],
    };
  }
  async readRegion(level: number, r: PlaneRequest): Promise<Pixels> {
    const info = await this.level(level),
      axes = this.metadata.axes.map((a) => a.name),
      plans = planChunks(info, axes, r);
    const decoded = info.chunks.reduce((n, d) => n * d, info.bytes) * plans.length;
    const release = await this.session.reserveDecoded(decoded);
    try {
      this.stats.decoded_bytes = (this.stats.decoded_bytes ?? 0) + decoded;
      const out = allocate(info, r.width * r.height);
      const chunks = await Promise.all(
        plans.map((p) => this.object(this.metadata.levels[level].path + '/' + p.key)),
      );
      for (let i = 0; i < plans.length; i++)
        await this.decode(info, axes, plans[i], chunks[i]!, r, out, level);
      this.signal.throwIfAborted();
      return out;
    } finally {
      release();
    }
  }
  private async decode(
    info: ArrayInfo,
    axes: string[],
    plan: ChunkPlan,
    bytes: Uint8Array,
    r: PlaneRequest,
    out: Pixels,
    level: number,
  ) {
    await serialize(async () => {
      this.signal.throwIfAborted();
      if (!bytes.byteLength) throw Error('Empty original chunk: refusing fill-value substitution');
      const started = performance.now();
      const { database, ensureZarr } = await import('../database');
      await ensureZarr();
      const { db, connection } = await database();
      this.signal.throwIfAborted();
      const root = `https://musivarium-chunk.invalid/${crypto.randomUUID()}.zarr/`;
      const meta = chunkView(info, axes),
        json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
      const group = {
        zarr_format: 3,
        node_type: 'group',
        attributes: {},
        consolidated_metadata: { kind: 'inline', must_understand: false, metadata: { '0': meta } },
      };
      const key = '0/c/' + axes.map(() => 0).join('/');
      const files: [string, Uint8Array][] = [
        ['zarr.json', json(group)],
        ['0/zarr.json', json(meta)],
        [key, bytes.slice()],
      ];
      const registered: string[] = [];
      const xi = axes.indexOf('x'),
        yi = axes.indexOf('y'),
        x = Math.max(r.x, plan.origin[xi]),
        y = Math.max(r.y, plan.origin[yi]);
      const width = Math.min(r.x + r.width, plan.origin[xi] + info.chunks[xi]) - x,
        height = Math.min(r.y + r.height, plan.origin[yi] + info.chunks[yi]) - y;
      const predicates = axes.map((a, i) =>
        a === 'x'
          ? `x BETWEEN ${x - plan.origin[i]} AND ${x - plan.origin[i] + width - 1}`
          : a === 'y'
            ? `y BETWEEN ${y - plan.origin[i]} AND ${y - plan.origin[i] + height - 1}`
            : `${a} = ${(a === 'c' ? r.channel : r[a as 'z' | 't']) - plan.origin[i]}`,
      );
      const sql = `SELECT x,y,value FROM read_zarr('${root}', array_path := '0') WHERE ${predicates.join(' AND ')} ORDER BY y,x`;
      try {
        for (const [path, data] of files) {
          await db.registerFileBuffer(root + path, data);
          registered.push(root + path);
        }
        const table = await connection.query(sql);
        this.signal.throwIfAborted();
        if (table.numRows !== width * height)
          throw Error(`DuckDB-Zarr returned ${table.numRows} pixels; expected ${width * height}`);
        const xs = table.getChild('x')!,
          ys = table.getChild('y')!,
          values = table.getChild('value')!;
        for (let i = 0; i < table.numRows; i++) {
          const px = Number(xs.get(i)) + plan.origin[xi],
            py = Number(ys.get(i)) + plan.origin[yi],
            value = values.get(i);
          if (
            px !== x + (i % width) ||
            py !== y + Math.floor(i / width) ||
            value === null ||
            value === undefined
          )
            throw Error('DuckDB-Zarr returned invalid coordinates or missing native pixels');
          out[(py - r.y) * r.width + px - r.x] = Number(value);
        }
        this.stats.chunk_views!.push({
          original_chunk_url: new URL(this.metadata.levels[level].path + '/' + plan.key, this.url)
            .href,
          original_shape: info.shape,
          chunk_origin: plan.origin,
          wrapper_metadata: meta,
          sql,
          rows: table.numRows,
        });
        this.stats.decode_copy_ms = (this.stats.decode_copy_ms ?? 0) + performance.now() - started;
      } finally {
        const dropped = await Promise.allSettled(
          registered.reverse().map((name) => db.dropFile(name)),
        );
        const failure = dropped.find((r) => r.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      }
    });
  }
}
