import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installIdrFixtures, source } from './support/idr-fixtures';
test('the demo reads original image and labels through DuckDB-Zarr, without extra channels', async ({
  page,
  context,
}) => {
  const network = await installIdrFixtures(context),
    software: string[] = [],
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes('zarr.duckdb_extension.wasm')) software.push(r.url());
  });
  await page.goto('/');
  await expect(page.locator('#raw')).toBeEnabled({ timeout: 45000 });
  const run = JSON.parse((await page.locator('#run-details').textContent())!);
  expect(run.settings.reader).toBe('duckdb-zarr');
  expect(run.stats.decoding_backend).toBe('duckdb-zarr');
  expect(run.stats.chunk_views.length).toBeGreaterThanOrEqual(2);
  expect(
    run.stats.chunk_views.every(
      (v: any) =>
        v.sql.includes('read_zarr') &&
        v.original_chunk_url.startsWith(source) &&
        v.wrapper_metadata.zarr_format === 3,
    ),
  ).toBe(true);
  expect(software.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  expect(network.unexpected).toEqual([]);
  const data = network.requests.filter((u) => /\/0\/\d+\/\d+\/\d+$/.test(u));
  expect([...new Set(data)].sort()).toEqual(
    [source + '0/42/0/0', source + 'labels/0/0/0/0/0', source + 'labels/0/0/0/1/0'].sort(),
  );
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(
    page.locator('#about').getByRole('link', { name: 'DuckDB-Zarr', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('#about').getByRole('link', { name: 'zarrita', exact: true }),
  ).toHaveCount(0);
});
test('DuckDB native-byte hashes and registered chunk readbacks match the independent reference', async ({
  page,
  context,
}) => {
  const network = await installIdrFixtures(context);
  const manifest = JSON.parse(
    readFileSync(new URL('../fixtures/idr0076-10501752/manifest.json', import.meta.url), 'utf8'),
  );
  await page.goto('/?count=100000');
  const result = await page.evaluate(
    async ({ source, region }) => {
      const path = '/src/sources/duckdb-zarr.ts',
        dbPath = '/src/database.ts';
      const { DuckDBZarrSource } = await import(path),
        { database } = await import(dbPath),
        { db } = await database();
      const hash = async (b: Uint8Array) =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b))))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      const register = db.registerFileBuffer.bind(db),
        registeredHashes: string[] = [],
        readbackHashes: string[] = [];
      db.registerFileBuffer = async (name: string, bytes: Uint8Array) => {
        const expected = await hash(bytes);
        await register(name, bytes);
        if (name.includes('/0/c/')) {
          registeredHashes.push(expected);
          readbackHashes.push(await hash(await db.copyFileToBuffer(name)));
        }
      };
      try {
        const c = new AbortController(),
          image = await DuckDBZarrSource.open(source, c.signal),
          labels = await DuckDBZarrSource.open(source + 'labels/0/', c.signal);
        const request = {
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
          z: 0,
          t: 0,
          channel: 42,
        };
        const pixels = await image.readRegion(0, request),
          mask = await labels.readRegion(0, { ...request, channel: 0 });
        return {
          imageHash: await hash(new Uint8Array(pixels.buffer)),
          labelHash: await hash(new Uint8Array(mask.buffer)),
          imageType: pixels.constructor.name,
          labelType: mask.constructor.name,
          registeredHashes,
          readbackHashes,
          remaining: (await db.globFiles('*')).filter((f: any) =>
            f.fileName.includes('musivarium-chunk.invalid'),
          ),
        };
      } finally {
        db.registerFileBuffer = register;
      }
    },
    { source, region: manifest.region },
  );
  expect(result.imageHash).toBe(manifest.files.image.sha256);
  expect(result.labelHash).toBe(manifest.files.labels.sha256);
  expect(result.imageType).toBe('Float64Array');
  expect(result.labelType).toBe('Int16Array');
  expect(result.registeredHashes.length).toBe(3);
  expect(result.readbackHashes).toEqual(result.registeredHashes);
  expect(result.remaining).toEqual([]);
  const originalURLs = [
    source + '0/42/0/0',
    source + 'labels/0/0/0/0/0',
    source + 'labels/0/0/0/1/0',
  ];
  expect([...result.registeredHashes].sort()).toEqual(
    manifest.sources
      .filter((s: any) => originalURLs.includes(s.url))
      .map((s: any) => s.sha256)
      .sort(),
  );
  expect(network.unexpected).toEqual([]);
});
