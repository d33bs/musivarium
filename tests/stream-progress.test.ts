import { afterEach, expect, it, vi } from 'vitest';
import { fetchObject } from '../src/sources/transport';
afterEach(() => vi.unstubAllGlobals());
it('reports streamed bytes before the response finishes, with a real size when provided', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            stream = c;
            c.enqueue(Uint8Array.from([1, 2]));
          },
        }),
        { headers: { 'Content-Length': '4' } },
      ),
  );
  const events: any[] = [];
  let finished = false;
  const pending = fetchObject(
    new Request('https://example.invalid/chunk'),
    new AbortController().signal,
    () => {},
    (event) => events.push(event),
  ).then((r) => {
    finished = true;
    return r;
  });
  await vi.waitFor(() =>
    expect(events.some((e) => e.state === 'data' && e.received === 2 && e.total === 4)).toBe(true),
  );
  expect(finished).toBe(false);
  stream.enqueue(Uint8Array.from([3, 4]));
  stream.close();
  expect(Array.from(new Uint8Array(await (await pending).arrayBuffer()))).toEqual([1, 2, 3, 4]);
  expect(events.at(-1)).toMatchObject({ state: 'complete', received: 4, total: 4, attempt: 1 });
});
it('does not invent a total for an unknown-length or HTTP-decoded response', async () => {
  for (const headers of [
    new Headers(),
    new Headers({ 'Content-Length': '2', 'Content-Encoding': 'gzip' }),
  ]) {
    vi.stubGlobal('fetch', async () => new Response(Uint8Array.from([1, 2, 3]), { headers }));
    const events: any[] = [];
    await fetchObject(
      new Request('https://example.invalid/chunk'),
      new AbortController().signal,
      () => {},
      (e) => events.push(e),
    );
    expect(
      events
        .filter((e) => e.state === 'headers' || e.state === 'data')
        .every((e) => e.total === null),
    ).toBe(true);
  }
});
