import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BrowserSource } from '../src/sources/browser';
const directory = new URL('./browser/fixtures/idr0076/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
const entries = new Map<string, { status: number; body: Uint8Array }>(
  manifest.entries.map((entry: { url: string; status: number; file: string }) => [
    entry.url,
    { status: entry.status, body: readFileSync(new URL(entry.file, directory)) },
  ]),
);
afterEach(() => vi.unstubAllGlobals());
it('subtracts successful chunk-download time from decoding/copying on actual IDR compressed bytes', async () => {
  const delay = 60;
  vi.stubGlobal('fetch', async (request: Request) => {
    const entry = entries.get(request.url);
    if (!entry) throw Error(`Unexpected source request ${request.url}`);
    if (request.url.endsWith('/0/42/0/0')) await new Promise((r) => setTimeout(r, delay));
    return new Response(new Uint8Array(entry.body).buffer, { status: entry.status });
  });
  // Warm the codec, not the reader's separate per-run byte cache.
  for (let run = 0; run < 2; run++) {
    const source = await BrowserSource.open(
      manifest.attribution.source,
      new AbortController().signal,
    );
    await source.alignment(0);
    const start = performance.now();
    await source.readRegion(0, { x: 160, y: 224, width: 64, height: 64, z: 0, t: 0, channel: 42 });
    const elapsed = performance.now() - start;
    const chunk = source.stats.objects.find((o) => o.url.endsWith('/0/42/0/0'))!;
    expect(chunk.started_at_ms).toBeTypeOf('number');
    expect(chunk.milliseconds!).toBeGreaterThanOrEqual(delay - 5);
    expect(source.stats.decode_copy_ms).toBeGreaterThanOrEqual(0);
    expect(Math.abs(source.stats.decode_copy_ms! - (elapsed - chunk.milliseconds!))).toBeLessThan(
      15,
    );
    expect(source.stats.decode_copy_ms!).toBeLessThan(elapsed - 40);
  }
});
