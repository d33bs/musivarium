import { test, expect } from '@playwright/test';
import { installIdrFixtures } from './support/idr-fixtures';

test('mobile voice box fits viewport; keyboard opening and Escape preserve an unsaved draft', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.locator('#csv')).toBeEnabled({ timeout: 45000 });
  await page.locator('.tile-voice-notes').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#voice-notes-dialog')).toBeVisible();
  await expect(page.locator('#voice-context')).not.toContainText('Unattached');
  await page.locator('#voice-text').fill('Unsaved microscopy note.');
  const bounds = await page.locator('#voice-notes-dialog').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width + bounds!.x).toBeLessThanOrEqual(390);
  expect(bounds!.height).toBeLessThanOrEqual(844);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(page.locator('#voice-notes-dialog')).toBeVisible();
  await expect(page.locator('#voice-text')).toHaveValue('Unsaved microscopy note.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#voice-close').click();
  await expect(page.locator('#voice-notes-dialog')).toBeHidden();
});
