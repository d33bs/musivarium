import { test, expect } from '@playwright/test';
import { installIdrFixtures } from './support/idr-fixtures';
test('completed view has no decorative mosaic heading or success message', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.locator('#raw')).toBeEnabled({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'Your mosaic', exact: true })).toHaveCount(0);
  await expect(page.locator('#status')).toBeHidden();
  await expect(page.locator('#status')).toHaveText('');
  await expect(page.getByText('03 / EXPLORE', { exact: true })).toHaveCount(0);
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects');
  await expect(page.locator('#shuffle')).toBeVisible();
  await expect(page.getByText('Microscopy, sampled.', { exact: true })).toHaveCount(0);
  await expect(page.locator('#sql-panel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  await expect(page.getByText('01 / SOURCE', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A closer look,', exact: false })).toHaveCount(0);
  await expect(page.getByText('Sample an image. Find objects.', { exact: false })).toHaveCount(0);
  await expect(page.locator('#close-settings')).toBeVisible();
  await expect(page.locator('#close-settings')).toHaveAccessibleName('Hide settings');
});
test('essential errors remain visible', async ({ page, context }) => {
  await installIdrFixtures(context);
  await page.goto('/?count=100000');
  await expect(page.locator('#status')).toBeVisible();
  await expect(page.locator('#status')).toContainText('Tile count');
});
