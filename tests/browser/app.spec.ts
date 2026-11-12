import { test, expect } from '@playwright/test';
import { installIdrFixtures, source } from './support/idr-fixtures';
test('automatic loading is cancellable with settings collapsed on desktop and mobile', async ({
  page,
  context,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const network = await installIdrFixtures(context, async (route) => {
    if (route.request().url() === source + '.zattrs') await gate;
    return false;
  });
  await page.goto('/');
  await expect(page.locator('#source')).toBeHidden();
  await expect(page.locator('#cancel')).toBeEnabled();
  await page.locator('#cancel').click();
  release();
  await expect(page.locator('#status')).toHaveText('Cancelled. No partial run was published.');
  expect(network.requests.filter((url) => url.endsWith('/0/42/0/0'))).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  await expect(page.locator('#source')).toBeVisible();
});
test('rejects invalid and unavailable sources, then can recover', async ({ page, context }) => {
  await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', { timeout: 15000 });
  await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  await page.locator('#source').fill('http://127.0.0.1:5183/missing.zarr/');
  await page.getByRole('button', { name: 'Sample objects', exact: true }).click();
  await expect(page.locator('#status')).toContainText(/Cannot open|404|metadata|node/, {
    timeout: 30000,
  });
  await expect(page.getByRole('button', { name: 'Sample objects', exact: true })).toBeEnabled();
});
