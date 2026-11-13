import { chromium, firefox } from '@playwright/test';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve('dist'),
  evidence = resolve(process.env.EVIDENCE_DIR || '.cache/musivarium-static-validation');
await mkdir(evidence, { recursive: true });
const fixtureRoot = resolve('tests/browser/fixtures/idr0076'),
  manifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8')),
  fixtures = new Map();
for (const entry of manifest.entries) {
  const body = await readFile(join(fixtureRoot, entry.file));
  if (
    body.length !== entry.bytes ||
    createHash('sha256').update(body).digest('hex') !== entry.sha256
  )
    throw Error('Corrupt original fixture');
  fixtures.set(entry.url, { ...entry, body });
}
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
};
const reports = [];
for (const prefix of ['', '/musivarium']) {
  const built = spawnSync('npm', ['run', 'build'], {
    env: { ...process.env, BASE_PATH: prefix ? prefix + '/' : './' },
    stdio: 'inherit',
    timeout: 90000,
  });
  if (built.status !== 0) throw Error('Production build failed');
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (prefix) {
        if (!path.startsWith(prefix + '/')) {
          res.writeHead(404).end();
          return;
        }
        path = path.slice(prefix.length);
      }
      const file = resolve(root, '.' + path + (path.endsWith('/') ? 'index.html' : ''));
      if (!file.startsWith(root + '/')) throw Error('Invalid path');
      const body = await readFile(file);
      res
        .writeHead(200, {
          'Content-Type': mime[extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`,
    base = origin + prefix + '/';
  const health = await fetch(base);
  if (!health.ok || !(await health.text()).includes('single-cell mosaics'))
    throw Error('Wrong preview target');
  if ((await fetch(origin + prefix + '/.git/config')).status !== 404)
    throw Error('Private files exposed');
  try {
    for (const [name, engine] of [
      ['chromium', chromium],
      ['firefox', firefox],
    ]) {
      const browser = await engine.launch();
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
          page = await context.newPage(),
          errors = [],
          unexpected = [],
          software = [],
          voiceModelRequests = [],
          voiceAssets = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('request', (req) => {
          if (/asr\.worker|transformers/i.test(req.url())) voiceAssets.push(req.url());
        });
        await context.addInitScript(() => {
          const streams = [];
          Object.defineProperty(globalThis, '__voiceTrackStates', {
            get: () => streams.flatMap((s) => s.getTracks().map((t) => t.readyState)),
          });
          Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
            value: async () => {
              const audio = new AudioContext({ sampleRate: 48000 });
              await audio.resume();
              const oscillator = audio.createOscillator(),
                destination = audio.createMediaStreamDestination();
              oscillator.connect(destination);
              oscillator.start();
              for (const track of destination.stream.getTracks()) {
                const stop = track.stop.bind(track);
                track.stop = () => {
                  stop();
                  oscillator.stop();
                  void audio.close();
                };
              }
              streams.push(destination.stream);
              return destination.stream;
            },
          });
        });
        await context.route('**/*', async (route) => {
          const url = route.request().url();
          if (url.startsWith(origin)) {
            if (url.includes('/models/') || url.includes('/vendor/')) software.push(url);
            return route.continue();
          }
          if (new URL(url).hostname === 'huggingface.co') {
            voiceModelRequests.push({ url, method: route.request().method() });
            return route.abort('blockedbyclient'); // Explicit model-download-failure control, not fake ASR.
          }
          const fixture = fixtures.get(url);
          if (!fixture) {
            unexpected.push(url);
            return route.abort();
          }
          return route.fulfill({
            status: fixture.status,
            body: fixture.body,
            headers: { 'Content-Type': fixture.contentType, 'Access-Control-Allow-Origin': '*' },
          });
        });
        await page.goto(base);
        if (!(await page.locator('#source').isHidden()))
          throw Error('Settings did not start collapsed');
        await page.waitForFunction(() => !document.querySelector('#raw')?.disabled, undefined, {
          timeout: 30000,
        });
        await page.waitForFunction(() => !document.querySelector('#csv')?.disabled, undefined, {
          timeout: 30000,
        });
        const native = JSON.parse(await page.locator('#run-details').textContent());
        if (native.cell_count !== 100) throw Error('Not 100 real objects');
        const exportFile = page.waitForEvent('download');
        await page.locator('#parquet').click();
        const download = await exportFile,
          output = join(evidence, `${name}-${prefix ? 'prefix' : 'root'}.parquet`);
        await download.saveAs(output);
        const data = await readFile(output);
        if (data.subarray(0, 4).toString() !== 'PAR1' || data.subarray(-4).toString() !== 'PAR1')
          throw Error('Invalid actual Parquet export');
        await page.screenshot({
          path: join(evidence, `${name}-${prefix ? 'prefix' : 'root'}-labels.png`),
          fullPage: true,
        });
        await page.getByRole('button', { name: 'Show settings', exact: true }).click();
        await page.locator('#segmentation').selectOption('model');
        await page.locator('#tile').selectOption('256');
        await page.locator('#target').fill('3');
        await page.locator('#count').fill('1');
        await page.locator('#run').click();
        await page.waitForFunction(() => !document.querySelector('#run').disabled, undefined, {
          timeout: 60000,
        });
        const text = await page.locator('#run-details').textContent();
        let model;
        try {
          model = JSON.parse(text);
        } catch {
          throw Error('Model run failed: ' + (await page.locator('#status').textContent()));
        }
        if (model.model_id !== 'stardist-dsb2018-90430209' || !(model.timings.segmentation > 0))
          throw Error('No actual neural inference');
        if (!software.some((u) => u.includes('/models/stardist-dsb2018.onnx')))
          throw Error('No real weight request');
        if (model.stats.objects.some((o) => o.url.includes('/labels/')))
          throw Error('Model path unexpectedly fetched labels');
        if (voiceAssets.length || voiceModelRequests.length)
          throw Error('ASR loaded at page startup');
        const voiceCell = await page.locator('.object-tile').first().getAttribute('data-id');
        await page.locator('.tile-voice-notes').first().click();
        await page.locator('#voice-record').click();
        await page.waitForFunction(
          () => parseFloat(document.querySelector('#voice-elapsed').textContent) > 0.5,
          undefined,
          { timeout: 15000 },
        );
        await page.locator('#voice-stop').click();
        await page.waitForFunction(
          () => !document.querySelector('#voice-retry').hidden,
          undefined,
          { timeout: 60000 },
        );
        if (!voiceAssets.some((url) => /asr\.worker/.test(url)) || !voiceModelRequests.length)
          throw Error('Production ASR worker/model-loading path was not exercised');
        if (voiceModelRequests.some((req) => req.method !== 'GET'))
          throw Error('Unexpected model request method');
        if (
          !(await page.evaluate(() =>
            globalThis.__voiceTrackStates.every((state) => state === 'ended'),
          ))
        )
          throw Error('Microphone track retained after Stop');
        await page
          .locator('#voice-text')
          .fill('Static production manual note: nucleus, cytoplasm, Zarr, StarDist.');
        await page.locator('#voice-save').click();
        await page.waitForFunction(
          () => document.querySelectorAll('.voice-saved-note').length === 1,
          undefined,
          { timeout: 15000 },
        );
        const noteDownload = page.waitForEvent('download', { timeout: 15000 });
        await page.locator('#voice-export').click();
        const noteFile = join(evidence, `${name}-${prefix ? 'prefix' : 'root'}-notes.json`);
        await (await noteDownload).saveAs(noteFile);
        const notes = JSON.parse(await readFile(noteFile, 'utf8')).notes;
        if (
          notes.length !== 1 ||
          notes[0].selectedCellIds[0] !== voiceCell ||
          notes[0].imageId !== native.settings.source ||
          notes[0].source !== 'manual'
        )
          throw Error('Voice note source/context/export mismatch');
        await page.locator('#voice-close').click();
        await page.reload();
        await page.locator('#voice-all').click();
        await page.waitForFunction(
          () => document.querySelectorAll('.voice-saved-note').length === 1,
          undefined,
          { timeout: 15000 },
        );
        if (
          !(await page.locator('.voice-note-text').textContent()).includes(
            'Static production manual note',
          )
        )
          throw Error('Note did not survive refresh');
        await page.screenshot({
          path: join(evidence, `${name}-${prefix ? 'prefix' : 'root'}-voice-notes.png`),
          fullPage: true,
        });
        if (errors.length || unexpected.length) throw Error(JSON.stringify({ errors, unexpected }));
        const report = {
          prefix: prefix || '/',
          browser: name,
          cells: native.cell_count,
          source: native.settings.source,
          readBytes: native.stats.bytes,
          parquetBytes: data.length,
          modelObjects: model.cell_count,
          modelMilliseconds: model.timings.segmentation,
          softwareRequests: software.length,
          voiceWorkerAssets: voiceAssets,
          voiceModelFailureControl: voiceModelRequests,
          savedNotes: notes.length,
          errors,
          unexpected,
        };
        reports.push(report);
        console.log(JSON.stringify(report));
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
}
await writeFile(join(evidence, 'results.json'), JSON.stringify(reports, null, 2) + '\n');
console.log('Verified static bundles; evidence: ' + evidence);
