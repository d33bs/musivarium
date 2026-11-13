import { test, expect } from '@playwright/test';
import { installIdrFixtures, source } from './support/idr-fixtures';
test('a corrupt original chunk fails without fallback and a fresh run recovers', async ({
  page,
  context,
}) => {
  let corrupt = true;
  const network = await installIdrFixtures(context, async (route) => {
    if (corrupt && route.request().url() === source + '0/42/0/0') {
      await route.fulfill({
        status: 200,
        body: Buffer.from([1, 2, 3]),
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
      return true;
    }
    return false;
  });
  await page.goto('/');
  await expect(page.locator('#status')).toHaveClass(/error/, { timeout: 20000 });
  await expect(page.locator('#raw')).toBeDisabled();
  expect(network.requests.filter((u) => u === source + '0/42/0/0')).toHaveLength(1);
  expect(network.unexpected).toEqual([]);
  corrupt = false;
  await page.reload();
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', { timeout: 20000 });
});
test('a modified official extension is rejected before decoding, without a Zarrita fallback', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  const pattern = '**/vendor/extensions/v2.0.0/wasm_eh/zarr.duckdb_extension.wasm';
  await context.route(pattern, (route) =>
    route.fulfill({ status: 200, body: Buffer.from([1, 2, 3]) }),
  );
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('extension size mismatch', {
    timeout: 20000,
  });
  await expect(page.locator('#raw')).toBeDisabled();
  await context.unroute(pattern);
  await page.reload();
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', { timeout: 20000 });
});
