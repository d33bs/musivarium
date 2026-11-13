import { test, expect } from '@playwright/test';
import { installIdrFixtures } from './support/idr-fixtures';
test('display controls live in the collapsed settings sidebar', async ({ page, context }) => {
  await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', { timeout: 15000 });
  for (const id of [
    'sort',
    'filter-area',
    'filter-intensity',
    'overlay',
    'context',
    'contrast',
    'display-low',
    'display-high',
    'size',
  ])
    await expect(page.locator('#' + id)).toBeHidden();
  await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  for (const id of [
    'sort',
    'filter-area',
    'filter-intensity',
    'overlay',
    'context',
    'contrast',
    'display-low',
    'display-high',
    'size',
  ])
    await expect(page.locator('#' + id)).toBeVisible();
});
test('the DuckDB-WASM SQL query UI is removed', async ({ page, context }) => {
  await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', { timeout: 15000 });
  await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  for (const id of ['sql-panel', 'sql', 'query', 'reset-query', 'query-result', 'db-status'])
    await expect(page.locator('#' + id)).toHaveCount(0);
});
test('the top bar shows an About dialog and a GitHub Source link, no tagline', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.getByText('Microscopy, sampled.', { exact: true })).toHaveCount(0);
  const source = page.locator('a.source-link');
  await expect(source).toHaveText('Source');
  await expect(source).toHaveAttribute('href', 'https://github.com/d33bs/musivarium');
  await expect(source.locator('svg')).toHaveCount(1);
  await page.getByRole('button', { name: 'About', exact: true }).click();
  const dialog = page.locator('#about');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'picture-thousand-records' })).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'DuckDB-Zarr', exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'zarrita' })).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'DuckDB-WASM' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'ONNX Runtime Web' })).toBeVisible();
  await page.getByRole('button', { name: 'Close about dialog' }).click();
  await expect(dialog).toBeHidden();
});
