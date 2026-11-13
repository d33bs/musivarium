#!/usr/bin/env node
/** Local, synthetic-only evaluation of the actual application AsrClient. No deployment. */
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import os from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const out = resolve(
  process.env.VOICE_EVIDENCE_DIR ||
    join(os.homedir(), '.hermes/cache/scratch/musivarium-voice-evaluation'),
);
const referencePath = join(root, 'scripts/voice-reference.json');
const reference = JSON.parse(await readFile(referencePath, 'utf8'));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const json = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n');
const command = (program, argv) => {
  const r = spawnSync(program, argv, { encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0)
    throw Error(`${program}: ${r.error?.message || r.stderr || r.status}`);
  return r.stdout.trim();
};
const tokens = (text) =>
  text
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
function wordErrors(referenceText, actualText) {
  const ref = tokens(referenceText),
    hyp = tokens(actualText);
  const table = Array.from({ length: ref.length + 1 }, () => new Uint16Array(hyp.length + 1));
  for (let i = 0; i <= ref.length; i++) table[i][0] = i;
  for (let j = 0; j <= hyp.length; j++) table[0][j] = j;
  for (let i = 1; i <= ref.length; i++)
    for (let j = 1; j <= hyp.length; j++) {
      table[i][j] = Math.min(
        table[i - 1][j] + 1,
        table[i][j - 1] + 1,
        table[i - 1][j - 1] + (ref[i - 1] !== hyp[j - 1]),
      );
    }
  let i = ref.length,
    j = hyp.length,
    substitutions = 0,
    deletions = 0,
    insertions = 0;
  const alignment = [];
  while (i || j) {
    if (i && j && table[i][j] === table[i - 1][j - 1] + (ref[i - 1] !== hyp[j - 1])) {
      const same = ref[i - 1] === hyp[j - 1];
      if (!same) substitutions++;
      alignment.push({
        kind: same ? 'equal' : 'substitute',
        reference: ref[--i],
        actual: hyp[--j],
        referenceIndex: i,
      });
    } else if (i && table[i][j] === table[i - 1][j] + 1) {
      deletions++;
      alignment.push({ kind: 'delete', reference: ref[--i], actual: null, referenceIndex: i });
    } else {
      insertions++;
      alignment.push({ kind: 'insert', reference: null, actual: hyp[--j], referenceIndex: i });
    }
  }
  return {
    referenceWords: ref.length,
    hypothesisWords: hyp.length,
    substitutions,
    deletions,
    insertions,
    errors: table[ref.length][hyp.length],
    wer: table[ref.length][hyp.length] / ref.length,
    alignment: alignment.reverse(),
  };
}
function repeatedPhrases(text) {
  const words = tokens(text),
    counts = new Map();
  for (let i = 0; i <= words.length - 6; i++) {
    const phrase = words.slice(i, i + 6).join(' ');
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([phrase, count]) => ({
      phrase,
      count,
      meaning:
        'repeated six-word span; possible hallucination, not proof of overlap-merging defect',
    }));
}
function boundaryReview(clip, text, alignment) {
  const actual = tokens(text),
    ref = tokens(clip.referenceText);
  return clip.anchors.map((anchor) => {
    const phrase = tokens(anchor.phrase),
      occurrences = [];
    for (let i = 0; i <= actual.length - phrase.length; i++)
      if (phrase.every((w, j) => actual[i + j] === w)) occurrences.push(i);
    const index = ref.findIndex((_, i) => phrase.every((w, j) => ref[i + j] === w));
    return {
      ...anchor,
      exactOccurrences: occurrences.length,
      status:
        occurrences.length === 1
          ? 'exactly-once'
          : occurrences.length
            ? 'duplicate-exact-phrase'
            : 'missing-or-recognition-error',
      hypothesisContexts: occurrences.map((i) =>
        actual.slice(Math.max(0, i - 8), i + phrase.length + 8).join(' '),
      ),
      localAlignment: alignment.filter(
        (a) => a.referenceIndex >= index - 8 && a.referenceIndex < index + phrase.length + 8,
      ),
    };
  });
}
function wav(samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++)
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + 2 * i);
  return b;
}
async function generate() {
  const ffmpeg = process.env.FFMPEG || command('/usr/bin/which', ['ffmpeg']);
  const voices = command('/usr/bin/say', ['-v', '?']);
  if (!voices.split('\n').some((s) => s.startsWith(reference.generator.voice + ' ')))
    throw Error('Required installed voice unavailable; do not download voices automatically.');
  const clips = [];
  if (
    reference.clips.length !== 10 ||
    ![30, 60, 90].every((n) => reference.clips.some((c) => c.targetSeconds === n))
  )
    throw Error('Expected ten clips including 30/60/90 s');
  for (const clip of reference.clips) {
    if (
      clip.targetSeconds < 30 ||
      clip.targetSeconds > 90 ||
      clip.segments.reduce((n, s) => n + s.seconds, 0) !== clip.targetSeconds
    )
      throw Error('Invalid duration: ' + clip.id);
    const parts = [],
      segments = [],
      anchors = [];
    let time = 0;
    for (const [i, segment] of clip.segments.entries()) {
      const stem = join(out, `${clip.id}-part-${i}`),
        aiff = stem + '.aiff',
        raw = stem + '.f32';
      command('/usr/bin/say', [
        '-v',
        reference.generator.voice,
        '-r',
        String(reference.generator.wordsPerMinute),
        '-o',
        aiff,
        segment.text,
      ]);
      command(ffmpeg, [
        '-nostdin',
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        aiff,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-f',
        'f32le',
        raw,
      ]);
      const input = await readFile(raw),
        source = new Float32Array(
          input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength),
        );
      const ratio = source.length / (16000 * segment.seconds);
      if (ratio < 0.65 || ratio > 1.5)
        throw Error(`Unreasonable speech stretch ${ratio}: ${clip.id} part ${i}`);
      // atempo preserves pitch; a sub-percent final resample makes the duration exact without silence padding.
      const adjusted = stem + '-tempo.f32';
      command(ffmpeg, [
        '-nostdin',
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'f32le',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-i',
        raw,
        '-af',
        `atempo=${ratio}`,
        '-f',
        'f32le',
        adjusted,
      ]);
      const body = await readFile(adjusted),
        stretched = new Float32Array(
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        );
      const target = new Float32Array(segment.seconds * 16000),
        correction = stretched.length / target.length;
      if (Math.abs(correction - 1) > 0.03) throw Error('Unexpected atempo correction');
      for (let j = 0; j < target.length; j++) {
        const position = j * correction,
          k = Math.floor(position),
          f = position - k;
        target[j] = (stretched[k] || 0) * (1 - f) + (stretched[k + 1] || 0) * f;
      }
      if (segment.anchor)
        anchors.push({
          atSeconds: time,
          phrase: segment.anchor,
          timingMeaning: 'start of the generated segment; natural short onset silence remains',
        });
      segments.push({
        startSeconds: time,
        seconds: segment.seconds,
        originalSeconds: source.length / 16000,
        atempo: ratio,
        finalResampleRatio: correction,
        words: tokens(segment.text).length,
      });
      parts.push(Buffer.from(target.buffer));
      time += segment.seconds;
    }
    const pcm = Buffer.concat(parts),
      samples = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    const pcmFile = `${clip.id}.f32`,
      wavFile = `${clip.id}.wav`;
    await writeFile(join(out, pcmFile), pcm);
    await writeFile(join(out, wavFile), wav(samples));
    let nonSilentFrames = 0,
      frames = 0,
      peak = 0;
    for (let i = 0; i < samples.length; i += 320) {
      let energy = 0;
      for (const x of samples.subarray(i, i + 320)) {
        energy += x * x;
        peak = Math.max(peak, Math.abs(x));
      }
      frames++;
      if (Math.sqrt(energy / 320) > 0.003) nonSilentFrames++;
    }
    const entry = {
      id: clip.id,
      label: 'SYNTHETIC — macOS say Samantha, rate-adjusted continuous original paragraphs',
      durationSeconds: samples.length / 16000,
      pcmFile,
      wavFile,
      pcmBytes: pcm.length,
      pcmSha256: sha(pcm),
      referenceText: clip.segments.map((s) => s.text).join(' '),
      anchors,
      segments,
      audioStats: {
        peak,
        nonSilent20msFramesFraction: nonSilentFrames / frames,
        thresholdRms: 0.003,
      },
    };
    clips.push(entry);
    console.log(
      JSON.stringify({
        generated: entry.id,
        seconds: entry.durationSeconds,
        sha256: entry.pcmSha256,
        speechFraction: entry.audioStats.nonSilent20msFramesFraction,
      }),
    );
    await json(join(out, 'clips.json'), {
      generatedAt: new Date().toISOString(),
      referenceSha256: sha(await readFile(referencePath)),
      ffmpeg: command(ffmpeg, ['-version']).split('\n')[0],
      voice: reference.generator,
      clips,
    });
  }
}
function rss(rootPid) {
  try {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], {
      encoding: 'utf8',
      timeout: 3000,
    })
      .trim()
      .split('\n')
      .map((s) => {
        const m = s.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        return m && { pid: +m[1], ppid: +m[2], rssKiB: +m[3], executable: m[4] };
      })
      .filter(Boolean);
    const wanted = new Set([rootPid]);
    let changed;
    do {
      changed = false;
      for (const p of rows)
        if (wanted.has(p.ppid) && !wanted.has(p.pid)) {
          wanted.add(p.pid);
          changed = true;
        }
    } while (changed);
    const processes = rows.filter((p) => wanted.has(p.pid));
    return { rssSumBytes: processes.reduce((n, p) => n + p.rssKiB * 1024, 0), processes };
  } catch (e) {
    return { error: e.message };
  }
}
await mkdir(out, { recursive: true });
if (args.has('--help')) {
  console.log(
    'node scripts/benchmark-voice.mjs [--generate-only | --reuse-audio] [--self-test]\nVOICE_EVIDENCE_DIR, VOICE_PORT (default 5197), VOICE_CLIPS (comma IDs), VOICE_TIMEOUT_MS (default 180000). Chromium only; no publish.',
  );
  process.exit(0);
}
if (args.has('--self-test')) {
  const check = wordErrors(
    'a nucleus has bright fluorescence',
    'a nucleus bright fluorescence extra',
  );
  if (check.deletions !== 1 || check.insertions !== 1 || check.wer !== 2 / 5)
    throw Error('WER self-test failed');
  const duplicate = boundaryReview(
    { referenceText: 'amber lantern', anchors: [{ phrase: 'amber lantern', atSeconds: 24 }] },
    'amber lantern amber lantern',
    [],
  );
  if (duplicate[0].exactOccurrences !== 2) throw Error('Boundary self-test failed');
  console.log('WER and duplicate-anchor self-tests passed.');
  process.exit(0);
}
if (!args.has('--reuse-audio')) await generate();
if (args.has('--generate-only')) process.exit(0);
const audio = JSON.parse(await readFile(join(out, 'clips.json'), 'utf8'));
if (audio.referenceSha256 !== sha(await readFile(referencePath)))
  throw Error('Audio is stale; regenerate from current reference');
for (const clip of audio.clips) {
  const b = await readFile(join(out, clip.pcmFile));
  if (b.length !== clip.pcmBytes || sha(b) !== clip.pcmSha256)
    throw Error('Audio hash mismatch: ' + clip.id);
}
const fixtureRoot = join(root, 'tests/browser/fixtures/idr0076');
const manifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8'));
const fixtures = new Map();
for (const entry of manifest.entries) {
  const body = await readFile(join(fixtureRoot, entry.file));
  if (body.length !== entry.bytes || sha(body) !== entry.sha256)
    throw Error('Corrupt original IDR fixture');
  fixtures.set(entry.url, { ...entry, body });
}
const runDir = join(out, 'run-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(runDir, { recursive: true });
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  label: reference.label,
  gitRevision: command('git', ['-C', root, 'rev-parse', 'HEAD']),
  host: {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    physicalMemoryBytes: os.totalmem(),
    node: process.version,
  },
  artifacts: { audioManifest: join(out, 'clips.json'), referenceSha256: audio.referenceSha256 },
  scope:
    'Actual AsrClient direct PCM calls after real UI StarDist and production recording-preparation release; not a microphone/recorder accuracy test.',
  memoryMeaning:
    'CDP page JS heap excludes worker/WASM. Sampled Chromium process-tree RSS sum includes shared pages more than once; neither measure is a proven peak or total exclusive memory bound.',
  trials: [],
  failures: [],
  console: [],
  requests: [],
  memorySamples: [],
};
for (const p of [
  'src/voice/asr-client.ts',
  'src/voice/asr.worker.ts',
  'src/voice/asr-config.ts',
  'src/main.ts',
  'package-lock.json',
  'scripts/benchmark-voice.mjs',
])
  report.artifacts[p] = sha(await readFile(join(root, p)));
const port = Number(process.env.VOICE_PORT || 5197),
  timeout = Number(process.env.VOICE_TIMEOUT_MS || 180000);
if (port === 5183) throw Error('Port 5183 reserved for parallel verification');
let phase = 'setup',
  server,
  browserServer,
  browser,
  context,
  page,
  sampling = false,
  timer;
const pending = new Set();
async function save() {
  await json(join(runDir, 'results.json'), report);
}
try {
  server = await createServer({
    root,
    // Independent runs must not invalidate another Vite server's optimized module URLs.
    cacheDir: join(runDir, '.vite'),
    optimizeDeps: { include: ['@huggingface/transformers'] },
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, fs: { allow: [root, out] } },
    plugins: [
      {
        name: 'voice-evaluation-audio',
        configureServer(s) {
          s.middlewares.use(async (req, res, next) => {
            const name = req.url?.split('?')[0]?.replace(/^\/__voice_evaluation\//, '');
            const clip = audio.clips.find((c) => c.pcmFile === name);
            if (!req.url?.startsWith('/__voice_evaluation/')) return next();
            if (!clip) {
              res.statusCode = 404;
              res.end();
              return;
            }
            res.setHeader('Content-Type', 'application/octet-stream');
            res.end(await readFile(join(out, clip.pcmFile)));
          });
        },
      },
    ],
  });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  report.origin = origin;
  if (!(await fetch(origin)).ok) throw Error('Local harness unavailable');
  browserServer = await chromium.launchServer({
    timeout: 30000,
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  browser = await chromium.connect(browserServer.wsEndpoint());
  report.browser = {
    engine: 'playwright Chromium',
    version: browser.version(),
    executable:
      rss(browserServer.process().pid).processes?.find((p) => p.pid === browserServer.process().pid)
        ?.executable ?? null,
    playwrightDefaultExecutable: chromium.executablePath(),
    rootPid: browserServer.process().pid,
    testedChrome: false,
    testedEdge: false,
    testedSafari: false,
  };
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['microphone'],
    serviceWorkers: 'block',
  });
  await context.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__voiceWorkers = [];
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.__entry = { url: String(url), createdAt: performance.now(), terminatedAt: null };
        window.__voiceWorkers.push(this.__entry);
      }
      terminate() {
        this.__entry.terminatedAt = performance.now();
        return super.terminate();
      }
    };
  });
  context.on('request', (request) => {
    const e = {
      phase,
      url: request.url(),
      method: request.method(),
      postDataBytes: request.postDataBuffer()?.length || 0,
      resourceType: request.resourceType(),
    };
    report.requests.push(e);
  });
  context.on('requestfailed', (request) =>
    report.failures.push({
      phase,
      kind: 'requestfailed',
      url: request.url(),
      failure: request.failure(),
    }),
  );
  context.on('response', (response) => {
    const observedPhase = phase;
    const task = (async () => {
      await response.finished();
      let sizes;
      try {
        sizes = await response.request().sizes();
      } catch {}
      const e = {
        phase: observedPhase,
        url: response.url(),
        status: response.status(),
        contentLength: response.headers()['content-length'] || null,
        accessControlAllowOrigin: response.headers()['access-control-allow-origin'] || null,
        responseBodyBytes: sizes?.responseBodySize ?? null,
        responseHeadersBytes: sizes?.responseHeadersSize ?? null,
        fromServiceWorker: response.fromServiceWorker(),
      };
      (report.responses ??= []).push(e);
    })()
      .catch((e) => report.failures.push({ kind: 'response-metrics', message: e.message }))
      .finally(() => pending.delete(task));
    pending.add(task);
  });
  await context.route('**/*', async (route) => {
    const req = route.request(),
      url = req.url();
    if (!['GET', 'HEAD'].includes(req.method()) || req.postDataBuffer()?.length) {
      report.failures.push({
        phase,
        kind: 'blocked-outbound-body-or-method',
        url,
        method: req.method(),
      });
      return route.abort();
    }
    if (url.startsWith(origin + '/')) return route.continue();
    const fixture = fixtures.get(url);
    if (fixture)
      return route.fulfill({
        status: fixture.status,
        body: fixture.body,
        headers: { 'Content-Type': fixture.contentType, 'Access-Control-Allow-Origin': '*' },
      });
    const host = new URL(url).hostname;
    if (
      host === 'huggingface.co' ||
      host.endsWith('.huggingface.co') ||
      host.endsWith('.hf.co') ||
      host === 'hf.co'
    )
      return route.continue();
    report.failures.push({ phase, kind: 'blocked-unexpected-host', url });
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) =>
    report.failures.push({ phase, kind: 'pageerror', message: e.message }),
  );
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()))
      report.console.push({ phase, type: m.type(), text: m.text() });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    const label = phase;
    try {
      const metrics = await cdp.send('Performance.getMetrics');
      const map = Object.fromEntries(metrics.metrics.map((m) => [m.name, m.value]));
      report.memorySamples.push({
        at: new Date().toISOString(),
        phase: label,
        pageJsHeapUsedBytes: map.JSHeapUsedSize,
        pageJsHeapTotalBytes: map.JSHeapTotalSize,
        ...rss(browserServer.process().pid),
      });
    } catch (e) {
      report.memorySamples.push({ phase: label, error: e.message });
    } finally {
      sampling = false;
    }
  }, 1000);
  async function prepareImageAndRelease(label, reload = false) {
    phase = label;
    if (reload) await page.reload();
    else await page.goto(origin);
    await page.waitForFunction(() => !document.querySelector('#csv')?.disabled, undefined, {
      timeout: 60000,
    });
    await page
      .locator('#toggle-settings')
      .count()
      .then(async (n) => {
        if (n) await page.locator('#toggle-settings').click();
        else await page.getByRole('button', { name: 'Show settings', exact: true }).click();
      });
    await page.locator('#segmentation').selectOption('model');
    await page.locator('#tile').selectOption('256');
    await page.locator('#target').fill('3');
    await page.locator('#count').fill('1');
    await page.locator('#run').click();
    await page.waitForFunction(() => !document.querySelector('#run').disabled, undefined, {
      timeout: 90000,
    });
    const details = JSON.parse(await page.locator('#run-details').textContent());
    if (details.model_id !== 'stardist-dsb2018-90430209' || !(details.timings.segmentation > 0))
      throw Error(
        'Actual StarDist inference not observed: ' + (await page.locator('#status').textContent()),
      );
    const before = await page.evaluate(() => window.__voiceWorkers);
    const image = before.filter((w) => /\/src\/worker\.ts/.test(w.url) && w.terminatedAt === null);
    if (!image.length) throw Error('No resident image worker before production release');
    // Exercise the real UI preparation callback, then cancel fake recording; do not substitute manual terminate().
    await page.locator('#voice-all').click();
    await page.locator('#voice-record').click();
    await page.locator('#voice-stop').waitFor({ state: 'visible' });
    await page.locator('#voice-cancel').click();
    const after = await page.evaluate(() => window.__voiceWorkers);
    const released = image.every((w) =>
      after.some((a) => a.url === w.url && a.createdAt === w.createdAt && a.terminatedAt !== null),
    );
    if (!released) throw Error('Production recording preparation did not release the image worker');
    await page.locator('#voice-close').click();
    (report.preparations ??= []).push({
      phase,
      modelId: details.model_id,
      modelMilliseconds: details.timings.segmentation,
      modelObjects: details.cell_count,
      imageWorkerReleased: released,
      before,
      after,
    });
    await save();
  }
  await prepareImageAndRelease('cold-stardist-setup');
  const selected = process.env.VOICE_CLIPS ? new Set(process.env.VOICE_CLIPS.split(',')) : null;
  const clips = audio.clips.filter((c) => !selected || selected.has(c.id));
  if (!clips.length || (selected && selected.size !== clips.length))
    throw Error('Invalid VOICE_CLIPS selection');
  const schedule = [
    { clip: clips[0], cacheState: 'cold-fresh-context-first-observed' },
    { clip: clips[0], cacheState: 'warm-same-context-after-reload' },
    ...clips.slice(1).map((clip) => ({ clip, cacheState: 'warm-same-context-new-worker' })),
  ];
  for (const [index, item] of schedule.entries()) {
    if (index === 1) await prepareImageAndRelease('warm-reload-stardist-setup', true);
    phase = `${item.cacheState}:${item.clip.id}`;
    const trial = {
      index,
      clipId: item.clip.id,
      cacheState: item.cacheState,
      durationSeconds: item.clip.durationSeconds,
      pcmSha256: item.clip.pcmSha256,
      startedAt: new Date().toISOString(),
      progress: [],
    };
    report.trials.push(trial);
    console.log(JSON.stringify({ start: phase }));
    try {
      // Start asynchronously; bounded Playwright wait permits timeout/cancel even if inference stalls.
      await page.evaluate(
        async ({ file, timeout }) => {
          const { AsrClient } = await import('/src/voice/asr-client.ts');
          const bytes = await (await fetch('/__voice_evaluation/' + file)).arrayBuffer();
          const client = new AsrClient(),
            start = performance.now();
          let last = start,
            lastFrame = start;
          const heartbeat = {
            ticks: 0,
            maxIntervalGapMs: 0,
            animationFrames: 0,
            maxAnimationFrameGapMs: 0,
            expectedIntervalMs: 50,
          };
          const interval = setInterval(() => {
            const now = performance.now();
            heartbeat.ticks++;
            heartbeat.maxIntervalGapMs = Math.max(heartbeat.maxIntervalGapMs, now - last);
            last = now;
          }, 50);
          let active = true;
          const frame = (now) => {
            if (!active) return;
            heartbeat.animationFrames++;
            heartbeat.maxAnimationFrameGapMs = Math.max(
              heartbeat.maxAnimationFrameGapMs,
              now - lastFrame,
            );
            lastFrame = now;
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
          const progress = [];
          window.__voiceTrial = { done: false };
          window.__voiceCancel = () => client.cancel();
          const deadline = setTimeout(() => client.cancel(), timeout);
          client
            .transcribe(new Float32Array(bytes), (p) =>
              progress.push({ elapsedMs: performance.now() - start, ...p }),
            )
            .then(
              (result) => {
                window.__voiceTrial = {
                  done: true,
                  result,
                  progress,
                  heartbeat,
                  wallMs: performance.now() - start,
                };
              },
              (error) => {
                window.__voiceTrial = {
                  done: true,
                  error: { name: error.name, message: error.message },
                  progress,
                  heartbeat,
                  wallMs: performance.now() - start,
                };
              },
            )
            .finally(() => {
              clearInterval(interval);
              clearTimeout(deadline);
              active = false;
            });
        },
        { file: item.clip.pcmFile, timeout },
      );
      await page.waitForFunction(() => window.__voiceTrial?.done, undefined, {
        timeout: timeout + 10000,
      });
      Object.assign(trial, await page.evaluate(() => window.__voiceTrial));
      trial.workersAfter = await page.evaluate(() => window.__voiceWorkers);
      if (trial.error) throw Error(trial.error.message);
      trial.wordErrors = wordErrors(item.clip.referenceText, trial.result.text);
      trial.transcriptSha256 = sha(trial.result.text);
      trial.repeatedSixWordSpans = repeatedPhrases(trial.result.text);
      trial.qualityFlags = [];
      if (trial.repeatedSixWordSpans.length)
        trial.qualityFlags.push('Repeated six-word spans require hallucination review.');
      if (trial.wordErrors.wer > 1)
        trial.qualityFlags.push(
          'WER exceeds 100%; completed inference is not acceptable transcription quality.',
        );
      trial.boundaryReview = boundaryReview(
        item.clip,
        trial.result.text,
        trial.wordErrors.alignment,
      );
      trial.referenceText = item.clip.referenceText;
      trial.status = 'completed';
      console.log(
        JSON.stringify({
          completed: item.clip.id,
          cacheState: item.cacheState,
          loadMs: trial.result.loadMs,
          transcriptionMs: trial.result.transcriptionMs,
          wer: trial.wordErrors.wer,
          intervalMaxGapMs: trial.heartbeat.maxIntervalGapMs,
        }),
      );
    } catch (e) {
      trial.status = 'failed';
      trial.failure = e.message;
      try {
        await page.evaluate(() => window.__voiceCancel?.());
      } catch {}
      report.failures.push({ phase, kind: 'transcription', message: e.message });
      console.error(e.message);
      // A failed cold dependency is not a reason to retry nine expensive identical failures.
      if (index === 0) {
        await save();
        break;
      }
    }
    await save();
  }
  report.cacheStorage = await page.evaluate(async () =>
    Promise.all(
      (await caches.keys()).map(async (name) => ({
        name,
        entries: (await (await caches.open(name)).keys()).map((r) => r.url),
      })),
    ),
  );
  await page.screenshot({ path: join(runDir, 'browser-after-evaluation.png'), fullPage: true });
} catch (e) {
  report.failures.push({ phase, kind: 'harness', message: e.message, stack: e.stack });
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  // Vite may abort an optimized import during a parallel edit; never hang in metrics cleanup.
  if (pending.size) {
    let deadline;
    const complete = await Promise.race([
      Promise.allSettled([...pending]).then(() => true),
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve(false), 5000);
      }),
    ]);
    clearTimeout(deadline);
    if (!complete)
      report.failures.push({ phase, kind: 'response-metrics-timeout', pending: pending.size });
  }
  const phases = [...new Set((report.responses || []).map((r) => r.phase))];
  report.responseByteSummary = phases.map((phase) => {
    const responses = report.responses.filter((r) => r.phase === phase),
      remote = responses.filter((r) => /^https:/.test(r.url));
    return {
      phase,
      responseCount: responses.length,
      remoteResponseCount: remote.length,
      observedRemoteResponseBodyBytes: remote.reduce((n, r) => n + (r.responseBodyBytes || 0), 0),
      unknownRemoteBodySizes: remote.filter((r) => r.responseBodyBytes === null).length,
      allObservedResponseBodyBytes: responses.reduce((n, r) => n + (r.responseBodyBytes || 0), 0),
    };
  });
  report.memorySummary = [...new Set(report.memorySamples.map((s) => s.phase))].map((phase) => {
    const samples = report.memorySamples.filter((s) => s.phase === phase),
      rssValues = samples.map((s) => s.rssSumBytes).filter(Number.isFinite),
      heaps = samples.map((s) => s.pageJsHeapUsedBytes).filter(Number.isFinite);
    return {
      phase,
      samples: samples.length,
      maxObservedChromiumTreeRssSumBytes: rssValues.length ? Math.max(...rssValues) : null,
      maxObservedPageJsHeapBytes: heaps.length ? Math.max(...heaps) : null,
    };
  });
  const successful = report.trials.filter((t) => t.status === 'completed'),
    unique = new Map(successful.map((t) => [t.clipId, t]));
  const errors = [...unique.values()].reduce((n, t) => n + t.wordErrors.errors, 0),
    words = [...unique.values()].reduce((n, t) => n + t.wordErrors.referenceWords, 0);
  report.summary = {
    successfulTrials: successful.length,
    uniqueSuccessfulClips: unique.size,
    plannedUniqueClips: process.env.VOICE_CLIPS ? process.env.VOICE_CLIPS.split(',').length : 10,
    aggregateWerUniqueLatestTrial: words ? errors / words : null,
    wordErrors: errors,
    referenceWords: words,
    allTenClipsCompleted: unique.size === 10,
    unexpectedOutboundBodyRequests: report.requests.filter(
      (r) => r.postDataBytes || !['GET', 'HEAD'].includes(r.method),
    ).length,
  };
  report.summary.qualityFlaggedTrials = successful
    .filter((t) => t.qualityFlags.length)
    .map((t) => ({ clipId: t.clipId, cacheState: t.cacheState, flags: t.qualityFlags }));
  report.summary.exactlyOnceBoundaryAnchorsUniqueClips = [...unique.values()]
    .flatMap((t) => t.boundaryReview)
    .filter((b) => b.exactOccurrences === 1).length;
  report.summary.totalBoundaryAnchorsUniqueClips = [...unique.values()].flatMap(
    (t) => t.boundaryReview,
  ).length;
  report.artifactsChangedDuringRun = [];
  for (const [path, hash] of Object.entries(report.artifacts)) {
    if (!path.startsWith('src/') && !path.startsWith('scripts/') && path !== 'package-lock.json')
      continue;
    const after = sha(await readFile(join(root, path)));
    if (after !== hash)
      report.artifactsChangedDuringRun.push({ path, beforeSha256: hash, afterSha256: after });
  }
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({ evidence: runDir, summary: report.summary, failures: report.failures }),
  );
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await browserServer?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (
    report.failures.length ||
    report.summary.uniqueSuccessfulClips !== report.summary.plannedUniqueClips
  )
    process.exitCode = 1;
  else if (report.summary.qualityFlaggedTrials.length) process.exitCode = 2;
}
