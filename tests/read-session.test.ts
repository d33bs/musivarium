import { it, expect, vi, afterEach } from 'vitest';
import { ReadSession } from '../src/sources/read-session';
afterEach(() => vi.unstubAllGlobals());
it('limits every source to a shared four in-flight downloads', async () => {
  let active = 0,
    maximum = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  vi.stubGlobal('fetch', async () => {
    active++;
    maximum = Math.max(maximum, active);
    await gate;
    active--;
    return new Response(Uint8Array.from([1, 2]), { headers: { 'Content-Length': '2' } });
  });
  const snapshots: any[] = [];
  const session = new ReadSession(new AbortController().signal, (s) => snapshots.push(s));
  const reads = Array.from({ length: 9 }, (_, i) =>
    session.request(new Request(`https://example.invalid/${i}`), () => {}),
  );
  await vi.waitFor(() => expect(active).toBe(4));
  expect(session.snapshot().queued).toBe(5);
  release();
  await Promise.all(reads);
  expect(maximum).toBe(4);
  expect(session.snapshot()).toMatchObject({
    active: 0,
    queued: 0,
    receivedBytes: 18,
    totalBytes: 18,
    completed: 9,
    maxActive: 4,
  });
  expect(snapshots.some((s) => s.active === 4)).toBe(true);
});
it('caps the aggregate decoded-chunk reservation while reads overlap', async () => {
  const session = new ReadSession(new AbortController().signal),
    first = await session.reserveDecoded(48 * 1024 * 1024);
  let secondStarted = false;
  const second = session.reserveDecoded(32 * 1024 * 1024).then((release) => {
    secondStarted = true;
    return release;
  });
  await Promise.resolve();
  expect(secondStarted).toBe(false);
  expect(session.snapshot().decodedBytes).toBe(48 * 1024 * 1024);
  first();
  const release = await second;
  expect(secondStarted).toBe(true);
  expect(session.snapshot().maxDecodedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  release();
  expect(session.snapshot().decodedBytes).toBe(0);
});
it('cancels active and queued downloads rather than starting queued work', async () => {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    (request: Request) =>
      new Promise((_resolve, reject) => {
        calls++;
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        });
      }),
  );
  const controller = new AbortController(),
    session = new ReadSession(controller.signal);
  const jobs = Array.from({ length: 8 }, (_, i) =>
    session.request(new Request(`https://example.invalid/${i}`), () => {}),
  );
  const settled = Promise.allSettled(jobs);
  await vi.waitFor(() => expect(calls).toBe(4));
  controller.abort();
  expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
  expect(calls).toBe(4);
  expect(session.snapshot()).toMatchObject({ active: 0, queued: 0 });
});
