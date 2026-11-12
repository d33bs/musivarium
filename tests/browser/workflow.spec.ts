import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { installIdrFixtures, fixtureManifest, source } from './support/idr-fixtures';

test.use({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
test.setTimeout(120000);

type Row = {
  cell_id: string;
  area: number;
  label: number;
  channel_42_mean: number;
  z: number;
  t: number;
  channels: string;
  [key: string]: unknown;
};
async function sample(page: Page) {
  await expect(page.locator('#run')).toBeEnabled({ timeout: 45000 });
  if (await page.locator('#source').isHidden())
    await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  if (await page.locator('#raw').isDisabled())
    await page.getByRole('button', { name: 'Sample objects', exact: true }).click();
  await expect(page.locator('#raw')).toBeEnabled({ timeout: 45000 });
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects');
}
async function exportsReady(page: Page) {
  await expect(page.locator('#csv')).toBeEnabled({ timeout: 20000 });
}
async function nativeRows(page: Page): Promise<Row[]> {
  const bytes = await download(page, 'raw', test.info());
  return JSON.parse(strFromU8(unzipSync(bytes)['manifest.json'])).cells.sort((a: Row, b: Row) =>
    a.cell_id.localeCompare(b.cell_id),
  );
}
async function rows(page: Page, sql = 'SELECT * FROM cells ORDER BY cell_id'): Promise<Row[]> {
  return page.evaluate(async (sql) => {
    const modulePath = '/src/database.ts';
    const db = await import(modulePath);
    return (await db.queryCells(sql)).rows;
  }, sql);
}
async function download(page: Page, id: string, info: TestInfo) {
  const pending = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#' + id).click({ timeout: 15000 });
  let result;
  try {
    result = await pending;
  } catch {
    throw Error(`No ${id} download: ${await page.locator('#status').textContent()}`);
  }
  const path = info.outputPath(result.suggestedFilename());
  await result.saveAs(path);
  return readFile(path);
}
async function canvas(page: Page) {
  return page
    .locator('#mosaic canvas')
    .first()
    .evaluate((el) => (el as HTMLCanvasElement).toDataURL());
}
function npy(bytes: Uint8Array) {
  expect([...bytes.slice(0, 8)]).toEqual([147, 78, 85, 77, 80, 89, 1, 0]);
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
      8,
      true,
    ),
    header = strFromU8(bytes.subarray(10, 10 + headerLength));
  const dtype = header.match(/'descr': '([^']+)'/)![1],
    shape = header
      .match(/'shape': \((\d+), (\d+)\)/)!
      .slice(1)
      .map(Number);
  expect(header).toContain("'fortran_order': False");
  const values: number[] = [],
    data = new DataView(
      bytes.buffer,
      bytes.byteOffset + 10 + headerLength,
      bytes.byteLength - 10 - headerLength,
    ),
    size = dtype === '<f8' ? 8 : 4;
  expect(data.byteLength).toBe(shape[0] * shape[1] * size);
  for (let i = 0; i < data.byteLength; i += size)
    values.push(dtype === '<f8' ? data.getFloat64(i, true) : data.getUint32(i, true));
  return { dtype, shape, values };
}

test('offline original IDR bytes: metadata, 100 objects, inspector, display controls and virtualization', async ({
  page,
  context,
}) => {
  const network = await installIdrFixtures(context);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', { timeout: 15000 });
  await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  const beforeInspect = network.requests.filter((url) => /\/\d+\/\d+\/\d+$/.test(url)).length;
  await expect(page.locator('#channels')).toHaveValue('42');
  await expect(page.locator('#target')).toHaveValue('100');
  await page.locator('#inspect').click();
  await expect(page.locator('#status')).toContainText('Metadata ready.', { timeout: 30000 });
  await expect(page.locator('#metadata')).toContainText('c 50 · y 494 · x 464');
  await expect(page.locator('#metadata')).toContainText('float64');
  expect(network.requests.filter((url) => /\/\d+\/\d+\/\d+$/.test(url))).toHaveLength(
    beforeInspect,
  );
  await sample(page);
  const original = await nativeRows(page);
  expect(original).toHaveLength(100);
  expect(new Set(original.map((row) => row.cell_id)).size).toBe(100);
  for (const row of original) {
    expect(row.z).toBe(0);
    expect(row.t).toBe(0);
    expect(row.channels).toBe('42');
    expect(Number.isFinite(row.channel_42_mean)).toBe(true);
    expect(row.area).toBeGreaterThanOrEqual(20);
  }
  const run = JSON.parse((await page.locator('#run-details').textContent())!);
  expect(run.alignment.axes).toEqual(['c', 'y', 'x']);
  expect(run.settings.labelPath).toBe('0');
  expect(run.settings.cropSize).toBe(32);
  expect(run.stats.bytes).toBeLessThan(2_000_000);
  const tiles = page.locator('#mosaic [role=gridcell]');
  const initial = await tiles.first().getAttribute('data-id');
  await tiles.first().click();
  await expect(page.locator('#inspector')).toBeVisible();
  await expect(page.locator('#object-title')).toHaveText(initial!);
  await expect(page.locator('#object-fields')).toContainText('level 0, t 0, z 0');
  await expect(page.locator('#object-fields')).toContainText('Mean · channel 42');
  await page.locator('#close').click();
  await tiles.first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#inspector')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#overlay').uncheck();
  const fetched = network.requests.length,
    before = await canvas(page);
  await page.locator('#overlay').check();
  expect(await canvas(page)).not.toBe(before);
  await page.locator('#context').uncheck();
  const noContext = await canvas(page);
  await page.locator('#context').check();
  expect(await canvas(page)).not.toBe(noContext);
  await page.locator('#contrast').selectOption('fixed');
  await page.locator('#display-high').fill('100');
  const fixed = await canvas(page);
  await page.locator('#display-high').fill('1000');
  expect(await canvas(page)).not.toBe(fixed);
  await page.locator('#sort').selectOption('area-desc');
  const top = original.reduce((a, b) => (a.area > b.area ? a : b)).area;
  await expect(tiles.first()).toHaveAttribute('aria-label', new RegExp(`area ${top} pixels`));
  await page.locator('#filter-area').fill('100000');
  await expect(tiles).toHaveCount(0);
  await expect(page.locator('#result-count')).toHaveText('0 of 100 objects');
  await page.locator('#filter-area').fill('0');
  await page.locator('#filter-intensity').fill('1000000');
  await expect(tiles).toHaveCount(0);
  await page.locator('#filter-intensity').fill('0');
  expect(await tiles.count()).toBeLessThan(100);
  const firstTop = await tiles.first().getAttribute('data-id');
  await page.locator('#mosaic-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(() => tiles.first().getAttribute('data-id')).not.toBe(firstTop);
  await tiles.last().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#mosaic :focus')).toHaveCount(1);
  expect(network.requests).toHaveLength(fetched);
  expect(network.unexpected).toEqual([]);
  expect(errors).toEqual([]);
  const chunks = network.requests.filter((url) => /\/\d+\/\d+\/\d+$/.test(url));
  expect(chunks.length).toBeGreaterThan(0);
  expect(
    chunks.every((url) =>
      ['0/42/0/0', 'labels/0/0/0/0/0', 'labels/0/0/0/1/0'].some((key) => url === source + key),
    ),
  ).toBe(true);
});

test('CSV and Parquet exports follow the area-filtered visible subset and read back exactly', async ({
  page,
  context,
}, info) => {
  const network = await installIdrFixtures(context);
  await page.goto('/');
  await sample(page);
  await exportsReady(page);
  const original = await rows(page);
  expect(original).toHaveLength(100);
  const sorted = [...original].sort((a, b) => b.area - a.area),
    threshold = sorted[11].area;
  await page.locator('#filter-area').fill(String(threshold));
  const visible = original.filter((row) => row.area >= threshold);
  await expect(page.locator('#result-count')).toHaveText(`${visible.length} of 100 objects`);
  for (const format of ['csv', 'parquet'] as const) {
    const bytes = await download(page, format, info);
    if (format === 'parquet') {
      expect(bytes.subarray(0, 4).toString()).toBe('PAR1');
      expect(bytes.subarray(-4).toString()).toBe('PAR1');
    } else expect(bytes.toString()).toContain('cell_id');
    const back = await page.evaluate(
      async ({ format, data }) => {
        const modulePath = '/src/database.ts';
        const { database } = await import(modulePath),
          { db, connection } = await database();
        const name = `qa-readback.${format}`;
        await db.registerFileBuffer(name, new Uint8Array(data));
        try {
          const table = await connection.query(
            `SELECT cell_id, area, channel_42_mean FROM ${format === 'parquet' ? 'read_parquet' : 'read_csv_auto'}('${name}') ORDER BY cell_id`,
          );
          return JSON.parse(JSON.stringify(table.toArray()));
        } finally {
          await db.dropFile(name);
        }
      },
      { format, data: [...bytes] },
    );
    expect(back).toEqual(
      visible
        .map(({ cell_id, area, channel_42_mean }) => ({ cell_id, area, channel_42_mean }))
        .sort((a, b) => a.cell_id.localeCompare(b.cell_id)),
    );
  }
  const archive = await download(page, 'raw', info);
  expect([...archive.subarray(0, 4)]).toEqual([80, 75, 3, 4]);
  const files = unzipSync(archive),
    manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(manifest.cells.map((row: Row) => row.cell_id).sort()).toEqual(
    visible.map((row) => row.cell_id).sort(),
  );
  expect(Object.keys(files)).toHaveLength(1 + 2 * visible.length);
  for (const row of manifest.cells) {
    const pixels = npy(files[`${row.cell_id}/channel_42.npy`]),
      labels = npy(files[`${row.cell_id}/labels.npy`]);
    expect(pixels.dtype).toBe('<f8');
    expect(labels.dtype).toBe('<u4');
    expect(pixels.shape).toEqual([row.crop_height, row.crop_width]);
    expect(labels.shape).toEqual(pixels.shape);
    const target = pixels.values.filter((_value, index) => labels.values[index] === row.label);
    expect(target).toHaveLength(row.area);
    expect(target.reduce((a, b) => a + b, 0) / target.length).toBeCloseTo(row.channel_42_mean, 10);
    expect(pixels.values.some((value) => value !== Math.round(value))).toBe(true);
  }
  const run = JSON.parse((await download(page, 'manifest', info)).toString());
  expect(run.settings.source).toBe(source);
  expect(run.cell_count).toBe(100);
  expect(run.settings.channels).toEqual([42]);
  await page.locator('#filter-area').fill('0');
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects');
  expect(await rows(page)).toEqual(original);
  expect(network.unexpected).toEqual([]);
  expect(network.blockedSoftwareRequests).toEqual([]);
});

test('offline native ZIP, NPY dtypes and raw-pixel measurements round trip', async ({
  page,
  context,
}, info) => {
  const network = await installIdrFixtures(context);
  await page.goto('/');
  await sample(page);
  const archive = await download(page, 'raw', info);
  expect([...archive.subarray(0, 4)]).toEqual([80, 75, 3, 4]);
  const files = unzipSync(archive),
    manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(manifest.cells).toHaveLength(100);
  expect(Object.keys(files)).toHaveLength(201);
  for (const row of manifest.cells) {
    const pixels = npy(files[`${row.cell_id}/channel_42.npy`]),
      labels = npy(files[`${row.cell_id}/labels.npy`]);
    expect(pixels.dtype).toBe('<f8');
    expect(labels.dtype).toBe('<u4');
    expect(pixels.shape).toEqual([row.crop_height, row.crop_width]);
    expect(labels.shape).toEqual(pixels.shape);
    const target = pixels.values.filter((_value, index) => labels.values[index] === row.label);
    expect(target).toHaveLength(row.area);
    expect(target.reduce((a, b) => a + b, 0) / target.length).toBeCloseTo(row.channel_42_mean, 10);
  }
  const run = JSON.parse((await download(page, 'manifest', info)).toString());
  expect(run.settings.source).toBe(source);
  expect(run.cell_count).toBe(100);
  expect(run.settings.channels).toEqual([42]);
  expect(run.settings.tile).toBe(512);
  expect(run.tiles).toHaveLength(1);
  expect(run.tiles[0]).toMatchObject({ width: 464, height: 494 });
  const png = await download(page, 'mosaic-png', info);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(network.unexpected.filter((url) => !url.includes('extensions.duckdb.org'))).toEqual([]);
});

test('offline sampling URL reproduces exact object IDs and shuffle changes the seed', async ({
  page,
  context,
}) => {
  const network = await installIdrFixtures(context);
  await page.goto('/');
  await sample(page);
  const first = await nativeRows(page),
    url = page.url();
  expect(new URL(url).searchParams.get('seed')).toBe('42');
  await page.goto(url);
  await sample(page);
  expect(await nativeRows(page)).toEqual(first);
  await page.locator('#shuffle').click();
  await expect(page.locator('#raw')).toBeEnabled({ timeout: 45000 });
  expect(new URL(page.url()).searchParams.get('seed')).not.toBe('42');
  expect((await nativeRows(page)).map((row) => row.cell_id)).not.toEqual(
    first.map((row) => row.cell_id),
  );
  expect(network.unexpected).toEqual([]);
});

test('offline cancellation discards delayed original transport and recovers cleanly', async ({
  page,
  context,
}) => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    seen = new Promise<void>((resolve) => (started = resolve));
  let delay = true;
  const network = await installIdrFixtures(context, async (route) => {
    if (delay && route.request().url() === source + '0/42/0/0') {
      started();
      await gate;
    }
    return false;
  });
  await page.goto('/');
  await seen;
  await expect(page.locator('#cancel')).toBeEnabled();
  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toHaveText('Cancelled. No partial run was published.');
  await expect(page.locator('#mosaic [role=gridcell]')).toHaveCount(0);
  await expect(page.locator('#raw')).toBeDisabled();
  await expect(page.locator('#csv')).toBeDisabled();
  delay = false;
  release();
  await sample(page);
  expect(network.unexpected).toEqual([]);
});

test('synthetic failures only: unavailable transport and unsupported axes recover to real bytes', async ({
  page,
  context,
}) => {
  let failure: 'unavailable' | 'axes' | undefined = 'unavailable';
  const attributes = fixtureManifest.entries.find((entry) => entry.key === '.zattrs')!;
  const network = await installIdrFixtures(context, async (route) => {
    if (!failure || !route.request().url().startsWith(source)) return false;
    if (failure === 'unavailable') {
      await route.fulfill({
        status: 404,
        body: 'Deliberate test-only unavailable source',
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
      return true;
    }
    if (route.request().url() === attributes.url) {
      await route.fulfill({
        status: 200,
        json: { multiscales: [{ axes: ['c', 'banana', 'x'], datasets: [{ path: '0' }] }] },
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
      return true;
    }
    return false;
  });
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('Cannot open OME-Zarr', { timeout: 30000 });
  await expect(page.locator('#raw')).toBeDisabled();
  failure = 'axes';
  await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  await page.locator('#run').click();
  await expect(page.locator('#status')).toContainText('Unsupported axes', { timeout: 30000 });
  await expect(page.locator('#mosaic [role=gridcell]')).toHaveCount(0);
  failure = undefined;
  await sample(page);
  expect(network.unexpected).toEqual([]);
});
