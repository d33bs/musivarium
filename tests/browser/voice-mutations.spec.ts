import { test, expect } from '@playwright/test';
import { installIdrFixtures } from './support/idr-fixtures';

test('a pending local delete serializes editor mutations and cannot be closed mid-write', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  await page.goto('/');
  await page.locator('#voice-all').click();
  await page.locator('#voice-text').fill('Note to delete.');
  await page.locator('#voice-save').click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(1);
  // Explicitly delay the storage adapter, not the real transaction semantics.
  await page.evaluate(async () => {
    const path = '/src/voice/notes-store.ts';
    const { NotesStore } = await import(path);
    const remove = NotesStore.prototype.delete;
    NotesStore.prototype.delete = function (id: string) {
      return new Promise<void>((resolve, reject) => {
        Object.assign(globalThis, {
          releaseVoiceDelete: () => remove.call(this, id).then(resolve, reject),
        });
      });
    };
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.voice-delete').click();
  await expect(page.locator('#voice-new')).toBeDisabled();
  await expect(page.locator('#voice-save')).toBeDisabled();
  await page.locator('#voice-close').click();
  await expect(page.locator('#voice-notes-dialog')).toBeVisible();
  await expect(page.locator('#voice-status')).toContainText(/wait|finish/i);
  await page.evaluate(() =>
    (globalThis as unknown as { releaseVoiceDelete(): void }).releaseVoiceDelete(),
  );
  await expect(page.locator('.voice-saved-note')).toHaveCount(0);
  await expect(page.locator('#voice-new')).toBeEnabled();
});
