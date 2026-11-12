import { expect, test } from '@playwright/test';
import { installIdrFixtures, source } from './support/idr-fixtures';
test('automatically samples the default image without pressing Sample', async ({
  page,
  context,
}) => {
  const network = await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', { timeout: 15000 });
  await expect(page.locator('#mosaic [role=gridcell]').first()).toBeVisible();
  expect(network.requests.filter((url) => url === source + '0/42/0/0')).toHaveLength(1);
  expect(network.unexpected).toEqual([]);
});
test('choosing a supported preset automatically reloads its mosaic', async ({ page, context }) => {
  const network = await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', { timeout: 15000 });
  await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  await page.locator('#preset').selectOption('custom');
  await page.locator('#preset').selectOption('labels');
  await expect
    .poll(() => network.requests.filter((url) => url === source + '0/42/0/0').length)
    .toBe(2);
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects');
  expect(network.unexpected).toEqual([]);
});
test('automatically restores a shared seed, requested count and display settings', async ({
  page,
  context,
}) => {
  const network = await installIdrFixtures(context);
  await page.goto('/?seed=shared-auto&target=17&v.overlay=true');
  await expect(page.locator('#result-count')).toHaveText('17 of 17 objects', { timeout: 15000 });
  const run = JSON.parse((await page.locator('#run-details').textContent())!);
  expect(run.settings.seed).toBe('shared-auto');
  expect(run.settings.target).toBe(17);
  await expect(page.locator('#overlay')).toBeChecked();
  expect(network.requests.filter((url) => url === source + '0/42/0/0')).toHaveLength(1);
});
test('invalid shared settings remain actionable without silently loading default data', async ({
  page,
  context,
}) => {
  const network = await installIdrFixtures(context);
  await page.goto('/?count=100000');
  await expect(page.locator('#status')).toContainText('Tile count');
  await expect(page.locator('#cancel')).toBeDisabled();
  expect(network.requests).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Show settings', exact: true })).toBeVisible();
});
test('settings start collapsed and can be opened without replacing the mosaic', async ({
  page,
  context,
}) => {
  const network = await installIdrFixtures(context);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', { timeout: 15000 });
  const toggle = page.getByRole('button', { name: 'Show settings', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#source')).toBeHidden();
  await expect(page.locator('#shuffle')).toBeVisible();
  await expect(page.locator('#cancel')).toBeVisible();
  const full = await page.locator('.workspace').evaluate((el) => el.getBoundingClientRect().width),
    requests = network.requests.length;
  await toggle.click();
  await expect(page.locator('#source')).toBeVisible();
  await expect(page.locator('#controls-toggle')).toHaveAttribute('aria-expanded', 'true');
  const expanded = await page
    .locator('.workspace')
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(full).toBeGreaterThan(expanded + 250);
  await page.locator('#controls-toggle').click();
  await expect(page.locator('#source')).toBeHidden();
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects');
  expect(network.requests).toHaveLength(requests);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('#source')).toBeVisible();
  await page.locator('#close-settings').click();
  await expect(page.locator('#source')).toBeHidden();
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
