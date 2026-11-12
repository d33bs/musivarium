import { it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runPipeline } from '../src/pipeline';
import { DEFAULT_SETTINGS } from '../src/core';
afterEach(() => vi.unstubAllGlobals());
it('publishes image and label download progress throughout a real-data pipeline', async () => {
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
  const events: any[] = [];
  const result = await runPipeline(
    { ...DEFAULT_SETTINGS, target: 17 },
    { signal: new AbortController().signal, onNetwork: (e) => events.push(e) },
  );
  expect(result.cells).toHaveLength(17);
  expect(events.some((e) => e.receivedBytes > 1_000_000)).toBe(true);
  expect(events.at(-1)).toMatchObject({ active: 0, queued: 0 });
  expect(events.at(-1).receivedBytes).toBe(result.stats.bytes);
});
