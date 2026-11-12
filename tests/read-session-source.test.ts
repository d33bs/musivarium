import { it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { BrowserSource } from '../src/sources/browser';
import { ReadSession } from '../src/sources/read-session';
afterEach(() => vi.unstubAllGlobals());
it('reports original metadata and chunk bytes through the shared source session', async () => {
  const folder = new URL('./browser/fixtures/idr0076/', import.meta.url),
    manifest = JSON.parse(readFileSync(new URL('manifest.json', folder), 'utf8'));
  const entries = new Map(
    manifest.entries.map((e: any) => [
      e.url,
      { ...e, body: readFileSync(new URL(e.file, folder)) },
    ]),
  );
  vi.stubGlobal('fetch', async (request: Request) => {
    const e: any = entries.get(request.url);
    if (!e) throw Error('Unexpected URL ' + request.url);
    return new Response(new Uint8Array(e.body), {
      status: e.status,
      headers: { 'Content-Length': String(e.bytes) },
    });
  });
  const states: any[] = [],
    signal = new AbortController().signal,
    session = new ReadSession(signal, (s) => states.push(s));
  const source = await BrowserSource.open(manifest.attribution.source, signal, session);
  const pixels = await source.readRegion(0, {
    x: 160,
    y: 224,
    width: 64,
    height: 64,
    z: 0,
    t: 0,
    channel: 42,
  });
  expect(pixels).toBeInstanceOf(Float64Array);
  expect(pixels).toHaveLength(4096);
  expect(states.some((s) => s.receivedBytes >= 897324)).toBe(true);
  expect(session.snapshot().completed).toBe(5);
  expect(session.snapshot().maxDecodedBytes).toBeGreaterThan(0);
});
