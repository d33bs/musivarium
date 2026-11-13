import { test, expect } from '@playwright/test';
import { installIdrFixtures } from './support/idr-fixtures';

test('notes and badges distinguish identical real cell IDs from a different label source', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.locator('#csv')).toBeEnabled({ timeout: 45000 });
  await page.locator('.tile-voice-notes').first().click();
  await page.locator('#voice-text').fill('Correct label source note.');
  await page.locator('#voice-save').click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(1);
  // Copy actual run metadata, changing only label-source identity as a collision control.
  await page.evaluate(async () => {
    const path = '/src/voice/notes-store.ts';
    const { NotesStore, createNote } = await import(path);
    const store = new NotesStore();
    const [actual] = await store.list();
    await store.put(
      createNote(
        { ...actual, labelSource: 'different-instance-labels' },
        'Other segmentation source note.',
      ),
    );
    store.close();
  });
  await page.locator('#voice-close').click();
  await page.reload();
  await expect(page.locator('#csv')).toBeEnabled({ timeout: 45000 });
  await expect(page.locator('.tile-voice-notes').first()).toHaveAttribute(
    'aria-label',
    /, 1 saved$/,
  );
  await page.locator('.tile-voice-notes').first().click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(1);
  await expect(page.locator('.voice-note-text')).toHaveText('Correct label source note.');
  await page.locator('#voice-scope').click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(2);
  await expect(page.locator('#voice-list')).toContainText('Other segmentation source note.');
});
