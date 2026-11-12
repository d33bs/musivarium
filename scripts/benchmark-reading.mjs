import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
const args = process.argv.slice(2),
  get = (key, fallback) => {
    const i = args.indexOf(key);
    return i < 0 ? fallback : args[i + 1];
  };
const baseline = get('--baseline', 'http://127.0.0.1:5187'),
  candidate = get('--candidate', 'http://127.0.0.1:5184'),
  latency = Number(get('--latency', '80')),
  repeats = Number(get('--repeats', '3')),
  report = resolve(get('--report', '.cache/reading-benchmark.json'));
if (
  !Number.isSafeInteger(latency) ||
  latency < 0 ||
  latency > 2000 ||
  !Number.isSafeInteger(repeats) ||
  repeats < 1 ||
  repeats > 5
)
  throw Error('Invalid bounded benchmark settings');
const folder = new URL('../tests/browser/fixtures/idr0076/', import.meta.url),
  manifest = JSON.parse(await readFile(new URL('manifest.json', folder), 'utf8')),
  entries = new Map();
for (const entry of manifest.entries) {
  const body = await readFile(new URL(entry.file, folder));
  if (
    body.length !== entry.bytes ||
    createHash('sha256').update(body).digest('hex') !== entry.sha256
  )
    throw Error('Corrupt original fixture');
  entries.set(entry.url, { ...entry, body });
}
const browser = await chromium.launch(),
  runs = [];
try {
  for (let trial = 0; trial < repeats; trial++)
    for (const label of trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const origin = label === 'baseline' ? baseline : candidate,
        context = await browser.newContext(),
        page = await context.newPage(),
        requests = [];
      let active = 0,
        maxActive = 0;
      await context.routeWebSocket('**/*', (socket) => socket.close());
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (new URL(url).origin === new URL(origin).origin) return route.continue();
        const entry = entries.get(url);
        if (!entry) throw Error('Unexpected source object ' + url);
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((r) => setTimeout(r, latency));
          requests.push({ url, bytes: entry.bytes, sha256: entry.sha256 });
          await route.fulfill({
            status: entry.status,
            body: entry.body,
            headers: {
              'Content-Type': entry.contentType,
              'Content-Length': String(entry.bytes),
              'Access-Control-Allow-Origin': '*',
            },
          });
        } finally {
          active--;
        }
      });
      try {
        await page.goto(origin + '/src/pipeline.ts');
        const value = await page.evaluate(async () => {
          const pipelinePath = '/src/pipeline.ts',
            corePath = '/src/core.ts',
            { runPipeline } = await import(pipelinePath),
            { DEFAULT_SETTINGS } = await import(corePath),
            begin = performance.now();
          const result = await runPipeline(DEFAULT_SETTINGS, {
              signal: new AbortController().signal,
            }),
            milliseconds = performance.now() - begin;
          const cells = result.cells.map((c) => ({
              id: c.cell_id,
              label: c.label,
              area: c.area,
              cx: c.cx,
              cy: c.cy,
              x: c.x,
              y: c.y,
              width: c.width,
              height: c.height,
              means: c.means,
              crop: {
                x: c.crop.x,
                y: c.crop.y,
                width: c.crop.width,
                height: c.crop.height,
                pixels: c.crop.channels.map((p) => Array.from(p)),
              },
              mask: Array.from(c.mask),
            })),
            bytes = new TextEncoder().encode(JSON.stringify(cells)),
            hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('');
          return {
            milliseconds,
            cells: result.cells.length,
            bytes: result.stats.bytes,
            nativeCropHash: hash,
            timings: result.timings,
            z: result.settings.z,
            t: result.settings.t,
          };
        });
        if (value.cells !== 100 || value.z !== 0 || value.t !== 0)
          throw Error('Wrong sampling scope');
        const run = { label, trial, ...value, requestCount: requests.length, maxActive, requests };
        runs.push(run);
        console.log(
          JSON.stringify({
            label,
            trial,
            milliseconds: value.milliseconds,
            nativeCropHash: value.nativeCropHash,
            maxActive,
            requests: requests.length,
            bytes: value.bytes,
          }),
        );
      } finally {
        await context.close();
      }
    }
} finally {
  await browser.close();
}
const hashes = new Set(runs.map((r) => r.nativeCropHash)),
  sets = new Set(
    runs.map((r) => JSON.stringify(r.requests.map((x) => x.url + ' ' + x.sha256).sort())),
  ),
  counts = new Set(runs.map((r) => r.bytes));
if (hashes.size !== 1 || sets.size !== 1 || counts.size !== 1)
  throw Error('Native pixels, objects or transport scope differ');
const median = (a) => {
    a = [...a].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  },
  summary = Object.fromEntries(
    ['baseline', 'candidate'].map((label) => [
      label,
      {
        medianMilliseconds: median(
          runs.filter((r) => r.label === label).map((r) => r.milliseconds),
        ),
        maxConcurrentRequests: Math.max(
          ...runs.filter((r) => r.label === label).map((r) => r.maxActive),
        ),
      },
    ]),
  );
await mkdir(dirname(report), { recursive: true });
await writeFile(
  report,
  JSON.stringify(
    {
      mode: 'Original IDR HTTP entity-byte replay with controlled per-request latency; NOT a WAN speed forecast',
      latencyMilliseconds: latency,
      repeats,
      baseline,
      candidate,
      nativePixelsAndObjectMeasurementsIdentical: true,
      sourceObjectsAndBytesIdentical: true,
      summary,
      runs,
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ summary, report }, null, 2));
