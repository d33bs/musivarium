#!/usr/bin/env node
/** Opt-in real browser/HTTP parity; Vite must already be running.
 * node scripts/validate-live.mjs --url http://127.0.0.1:5184 --report /path/report.json
 * No fixtures are served in place of live pixels. A failed source fails the run.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error(`Missing ${name} value`);
  return args[index + 1];
}
const known = new Set(['--url', '--report', '--attempts', '--browser']);
for (let i = 0; i < args.length; i += 2)
  if (!known.has(args[i])) throw Error(`Unknown option ${args[i]}`);
const base = new URL(option('--url', process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:5184'));
if (!['http:', 'https:'].includes(base.protocol)) throw Error('Vite URL must use HTTP(S)');
const attempts = Number(option('--attempts', '2'));
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3)
  throw Error('--attempts must be 1–3');
const browserName = option('--browser', 'chromium');
const engine = { chromium, firefox, webkit }[browserName];
if (!engine) throw Error('--browser must be chromium, firefox or webkit');
const fixture = new URL('../tests/fixtures/idr0076-10501752/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', fixture), 'utf8'));
const expected = JSON.parse(await readFile(new URL('expected.json', fixture), 'utf8'));
for (const [kind, record] of Object.entries(manifest.files)) {
  const bytes = await readFile(new URL(record.path, fixture));
  assert.equal(bytes.byteLength, record.bytes, `${kind} fixture length`);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    record.sha256,
    `${kind} fixture hash`,
  );
  assert.equal(expected[`${kind}_sha256`], record.sha256, `${kind} Python reference hash`);
}
const report = {
  schema_version: 1,
  status: 'fail',
  started: new Date().toISOString(),
  origin: base.origin,
  browser: browserName,
  module: new URL('/src/sources/browser.ts', base).href,
  image_source: manifest.image_group,
  label_source: manifest.label_group,
  region: manifest.region,
  expected: {
    image_sha256: expected.image_sha256,
    labels_sha256: expected.labels_sha256,
    objects: expected.object_count,
    foreground_pixels: expected.foreground_pixels,
  },
  reference: expected.reference,
  attempts: [],
};
let browser;
try {
  browser = await engine.launch({ headless: true });
  report.browser_version = browser.version();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const page = await context.newPage();
    const networkFailures = [];
    page.on('requestfailed', (request) =>
      networkFailures.push({ url: request.url(), error: request.failure()?.errorText }),
    );
    const result = {
      attempt,
      started: new Date().toISOString(),
      status: 'fail',
      network_failures: networkFailures,
    };
    report.attempts.push(result);
    try {
      // Navigate to a real Vite-served module document, then dynamically import
      // it below. This keeps the local browser origin without running the app
      // or its HMR reloads. No route interception, proxy or mocked response.
      await page.goto(report.module, { waitUntil: 'load', timeout: 30000 });
      const actual = await page.evaluate(
        async ({ manifest }) => {
          const { BrowserSource, validateLabelAlignment } = await import('/src/sources/browser.ts');
          const { extractObjects } = await import('/src/core.ts');
          const signal = AbortSignal.timeout(90000);
          let imageSource, labelSource;
          const hash = async (bytes) =>
            Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
              value.toString(16).padStart(2, '0'),
            ).join('');
          try {
            imageSource = await BrowserSource.open(manifest.image_group, signal);
            labelSource = await BrowserSource.open(manifest.label_group, signal);
            const imageAlignment = await imageSource.alignment(0),
              labelAlignment = await labelSource.alignment(0);
            validateLabelAlignment(imageAlignment, labelAlignment);
            const roi = manifest.region;
            const image = await imageSource.readRegion(0, { ...roi, channel: 42 });
            const labels = await labelSource.readRegion(0, { ...roi, channel: 0 });
            if (!(image instanceof Float64Array) || !(labels instanceof Int16Array))
              throw Error(
                `Native dtype changed: ${image.constructor.name}, ${labels.constructor.name}`,
              );
            const imageBytes = new Uint8Array(image.length * 8),
              labelBytes = new Uint8Array(labels.length * 2);
            const iv = new DataView(imageBytes.buffer),
              lv = new DataView(labelBytes.buffer);
            image.forEach((value, i) => iv.setFloat64(i * 8, value, true));
            labels.forEach((value, i) => lv.setInt16(i * 2, value, true));
            return {
              status: 'pass',
              image_sha256: await hash(imageBytes),
              labels_sha256: await hash(labelBytes),
              image_type: image.constructor.name,
              labels_type: labels.constructor.name,
              image_alignment: imageAlignment,
              label_alignment: labelAlignment,
              objects: extractObjects(
                Uint32Array.from(labels),
                [image],
                roi.width,
                roi.height,
                roi,
              ),
              foreground_pixels: labels.reduce((sum, label) => sum + Number(label !== 0), 0),
              image_stats: imageSource.stats,
              label_stats: labelSource.stats,
            };
          } catch (error) {
            return {
              status: 'fail',
              error: error instanceof Error ? (error.stack ?? error.message) : String(error),
              image_stats: imageSource?.stats,
              label_stats: labelSource?.stats,
            };
          }
        },
        { manifest },
      );
      result.actual = actual;
      if (actual.status !== 'pass') throw Error(actual.error);
      assert.equal(actual.image_sha256, expected.image_sha256, 'live Float64 c42 ROI SHA-256');
      assert.equal(actual.labels_sha256, expected.labels_sha256, 'live Int16 label ROI SHA-256');
      assert.equal(
        actual.foreground_pixels,
        expected.foreground_pixels,
        'live foreground pixel count',
      );
      assert.equal(actual.objects.length, expected.objects.length, 'live object count');
      let maxCentroidError = 0,
        maxMeanError = 0;
      for (const [index, pinned] of expected.objects.entries()) {
        const object = actual.objects[index];
        for (const key of ['label', 'area', 'x', 'y', 'width', 'height', 'edge'])
          assert.equal(object[key], pinned[key], `label ${pinned.label} ${key}`);
        for (const key of ['cx', 'cy']) {
          const error = Math.abs(object[key] - pinned[key]);
          maxCentroidError = Math.max(maxCentroidError, error);
          assert.ok(error <= 1e-11, `label ${pinned.label} ${key} error ${error}`);
        }
        assert.equal(object.means.length, 1);
        const error = Math.abs(object.means[0] - pinned.means[0]);
        maxMeanError = Math.max(maxMeanError, error);
        assert.ok(error <= 1e-11, `label ${pinned.label} c42 mean error ${error}`);
      }
      result.comparison = {
        objects: actual.objects.length,
        image_bytes_exact: true,
        label_bytes_exact: true,
        native_area_bbox_and_boundary_exact: true,
        max_centroid_absolute_error: maxCentroidError,
        max_native_mean_absolute_error: maxMeanError,
        tolerance_absolute: 1e-11,
      };
      // Compact report: retain network evidence, checksums and comparison metrics;
      // full per-object independent values are pinned in expected.json.
      delete actual.objects;
      result.status = 'pass';
      report.status = 'pass';
      break;
    } catch (error) {
      result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    } finally {
      result.finished = new Date().toISOString();
      await page.close();
    }
  }
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await browser?.close();
  report.finished = new Date().toISOString();
  const output = JSON.stringify(report, null, 2) + '\n';
  const destination = option('--report', undefined);
  if (destination) {
    const path = destination.startsWith('file:') ? fileURLToPath(destination) : destination;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output);
  }
  process.stdout.write(output);
  if (report.status !== 'pass') process.exitCode = 1;
}
