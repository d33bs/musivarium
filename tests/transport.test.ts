import { it, expect, vi, afterEach } from 'vitest';
import { fetchObject } from '../src/sources/transport';
afterEach(() => vi.unstubAllGlobals());
it('retries a transient body failure, records both attempts, and preserves range', async () => {
  let calls = 0;
  const ranges: string[] = [];
  vi.stubGlobal('fetch', async (request: Request) => {
    ranges.push(request.headers.get('range')!);
    calls++;
    if (calls === 1) throw TypeError('connection closed');
    return new Response(Uint8Array.from([1, 2]), {
      status: 206,
      headers: { 'Content-Length': '2' },
    });
  });
  const attempts: any[] = [];
  const response = await fetchObject(
    new Request('https://example.org/chunk', { headers: { Range: 'bytes=0-1' } }),
    new AbortController().signal,
    (a) => attempts.push(a),
  );
  expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2]);
  expect(ranges).toEqual(['bytes=0-1', 'bytes=0-1']);
  expect(attempts).toHaveLength(2);
  for (const attempt of attempts) {
    expect(Number.isFinite(attempt.started_at_ms)).toBe(true);
    expect(attempt.milliseconds).toBeGreaterThanOrEqual(0);
  }
});
it('rejects oversized responses before allocating and does not retry 4xx', async () => {
  const f = vi.fn(async () => new Response('no', { status: 403 }));
  vi.stubGlobal('fetch', f);
  await expect(
    fetchObject(new Request('https://example.org/no'), new AbortController().signal, () => {}),
  ).rejects.toThrow(/403/);
  expect(f).toHaveBeenCalledTimes(1);
  vi.stubGlobal(
    'fetch',
    async () => new Response('abc', { headers: { 'Content-Length': String(20 * 1024 * 1024) } }),
  );
  await expect(
    fetchObject(new Request('https://example.org/big'), new AbortController().signal, () => {}),
  ).rejects.toThrow(/16 MiB/);
});
