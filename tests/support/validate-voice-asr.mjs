// Run with ASR_TEST_WAV=/absolute/16k-mono-pcm16.wav node tests/support/validate-voice-asr.mjs
// Synthetic speech proves local execution/compatibility, not human recognition accuracy.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { resolve, extname, join } from 'node:path';
import { build } from 'vite';
import { chromium, firefox } from '@playwright/test';

const root = process.cwd();
const scratch =
  process.env.ASR_TEST_OUTPUT ||
  join(process.env.HOME, '.hermes/cache/scratch/musivarium-asr-validation');
await mkdir(scratch, { recursive: true });
const wav = await readFile(process.env.ASR_TEST_WAV);
let pcm;
let format;
for (let offset = 12; offset + 8 <= wav.length;) {
  const name = wav.toString('ascii', offset, offset + 4);
  const size = wav.readUInt32LE(offset + 4);
  if (name === 'fmt ') format = wav.subarray(offset + 8, offset + 8 + size);
  if (name === 'data') pcm = wav.subarray(offset + 8, offset + 8 + size);
  offset += 8 + size + (size % 2);
}
if (
  !pcm ||
  format?.readUInt16LE(0) !== 1 ||
  format.readUInt16LE(2) !== 1 ||
  format.readUInt32LE(4) !== 16000 ||
  format.readUInt16LE(14) !== 16
) {
  throw Error('Expected genuine mono 16 kHz PCM16 WAV.');
}
const samples = Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
await build({
  configFile: false,
  root,
  base: './',
  publicDir: false,
  worker: { format: 'es' },
  build: {
    outDir: join(scratch, 'build'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(root, 'tests/support/voice-asr-browser.html') },
  },
});
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname.replace(/^\/musivarium\//, ''));
    if (relative.includes('..')) throw Error('Invalid path');
    const file = relative.startsWith('vendor/')
      ? join(root, 'public', relative)
      : join(scratch, 'build', relative);
    const data = await readFile(file);
    const types = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.wasm': 'application/wasm',
    };
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browserType = process.env.ASR_BROWSER === 'firefox' ? firefox : chromium;
const browser = await browserType.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const requests = [];
const consoleErrors = [];

const workers = [];
page.on('worker', (worker) => {
  workers.push({ url: worker.url(), closed: false });
  const record = workers.at(-1);
  worker.on('close', () => {
    record.closed = true;
  });
});
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('request', (request) =>
  requests.push({
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
  }),
);

try {
  // Nested path deliberately exercises relative BASE_URL resolution like GitHub Pages.
  await page.goto(`http://127.0.0.1:${port}/musivarium/tests/support/voice-asr-browser.html`);
  await page.waitForFunction(() => window.asrValidation);
  await page.waitForTimeout(250);
  const startupRequests = requests.slice();
  if (workers.length || requests.some((item) => /huggingface|onnxruntime|ort-wasm/.test(item.url)))
    throw Error('ASR eagerly loaded at startup');
  // The harness HTML is nested; use the deployed app root as the document base.
  await page.evaluate(() => {
    const base = document.createElement('base');
    base.href = '/musivarium/';
    document.head.append(base);
  });
  const crossOriginIsolated = await page.evaluate(() => window.crossOriginIsolated);
  const cancelledDownload = await page.evaluate(
    (audio) => window.asrValidation.cancelDuring(audio, 'download'),
    samples,
  );
  const first = await page.evaluate((audio) => window.asrValidation.run(audio), samples);
  const progress = await page.evaluate(() => window.asrValidation.progress);
  await page.waitForFunction(() => true);
  const models = await page.evaluate(async () => {
    const cache = await caches.open('transformers-cache');
    const keys = (await cache.keys()).filter((key) => key.url.includes('.onnx'));
    return Promise.all(
      keys.map(async (key) => {
        const bytes = await (await cache.match(key)).arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return {
          url: key.url,
          bytes: bytes.byteLength,
          sha256: Array.from(new Uint8Array(digest), (value) =>
            value.toString(16).padStart(2, '0'),
          ).join(''),
        };
      }),
    );
  });
  await page.waitForTimeout(100);
  if (!workers.every((worker) => worker.closed))
    throw Error('Worker was not released after completion');
  const cancelledInference = await page.evaluate(
    (audio) => window.asrValidation.cancelDuring(audio, 'transcribing'),
    samples,
  );
  // Keep local application scripts reachable, but deny every external request.
  // This tests cached local inference, not full application offline installation.
  const blockedExternal = [];
  await context.route(/^https:\/\//, (route) => {
    blockedExternal.push(route.request().url());
    console.log('Blocked external:', route.request().url());
    return route.abort();
  });
  const externalNetworkBlocked = await page.evaluate(
    (audio) => window.asrValidation.run(audio),
    samples,
  );
  await page.waitForTimeout(100);
  const expected = process.env.ASR_EXPECT_TEXT;
  if (expected && !first.text.toLowerCase().includes(expected.toLowerCase()))
    throw Error(`Missing expected text: ${JSON.stringify(first)}`);
  if (!first.text || first.text !== externalNetworkBlocked.text)
    throw Error('Cached local transcription differs');
  if (!workers.every((worker) => worker.closed)) throw Error('Worker was not released');
  if (requests.some((item) => item.method !== 'GET' || item.url.includes('/resolve/main/')))
    throw Error('Unexpected remote write or unpinned model request');
  if (requests.some((item) => item.url.includes('/assets/') && item.url.includes('.wasm')))
    throw Error('Unused asyncify runtime was fetched');
  const expectedModels = {
    'encoder_model_quantized.onnx': {
      bytes: 10124993,
      sha256: 'e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25',
    },
    'decoder_model_merged_quantized.onnx': {
      bytes: 30718858,
      sha256: 'c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52',
    },
  };
  if (
    models.length !== 2 ||
    models.some((item) => {
      const expected = expectedModels[new URL(item.url).pathname.split('/').at(-1)];
      return !expected || item.bytes !== expected.bytes || item.sha256 !== expected.sha256;
    })
  )
    throw Error('Browser-downloaded model hashes do not match Hugging Face LFS pins');
  const evidence = {
    recordedAt: new Date().toISOString(),
    browser: browserType.name(),
    version: browser.version(),
    crossOriginIsolated,
    inputWav: process.env.ASR_TEST_WAV,
    inputSha256: createHash('sha256').update(wav).digest('hex'),
    inputSeconds: samples.length / 16000,
    syntheticTestSpeech: true,
    startupRequests,
    cancelledDownload,
    cancelledInference,
    first,
    externalNetworkBlocked,
    blockedExternal,
    progress,
    models,
    workers,
    requests,
    consoleErrors,
  };
  await writeFile(
    join(scratch, `evidence-${browserType.name()}.json`),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        ...evidence,
        progress: { eventCount: progress.length, last: progress.slice(-3) },
        requests: { count: requests.length },
      },
      null,
      2,
    ),
  );
  console.log(`Evidence saved: ${join(scratch, `evidence-${browserType.name()}.json`)}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
