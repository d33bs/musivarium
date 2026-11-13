import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { installIdrFixtures } from './support/idr-fixtures';

test.use({ viewport: { width: 1440, height: 1000 } });
test('per-tile manual notes preserve context, persist, edit, export and delete without ASR downloads', async ({
  page,
  context,
}) => {
  const network = await installIdrFixtures(context);
  const errors: string[] = [],
    asrRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/huggingface|whisper|asr.worker/.test(request.url())) asrRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.locator('#csv')).toBeEnabled({ timeout: 45000 });
  const cellId = await page.locator('#mosaic .object-tile').first().getAttribute('data-id');
  await page.locator('.tile-voice-notes').first().click();
  await expect(page.locator('#voice-context')).toContainText(cellId!);
  await page.locator('#voice-text').fill('Nucleus: fluorescence.\nCytoplasm: α-tubulin.');
  await page.locator('#voice-save').click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(1);
  await expect(page.locator('#voice-status')).toContainText('Saved locally');
  await page.locator('#voice-close').click();
  await page.reload();
  await expect(page.locator('#csv')).toBeEnabled({ timeout: 45000 });
  await page.locator('.tile-voice-notes').first().click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(1);
  await page.locator('.voice-edit').click();
  await expect(page.locator('#voice-text')).toHaveValue(
    'Nucleus: fluorescence.\nCytoplasm: α-tubulin.',
  );
  await page.locator('#voice-text').fill('Edited: segmentation, Zarr, StarDist.');
  await page.locator('#voice-save').click();
  const pending = page.waitForEvent('download');
  await page.locator('#voice-export').click();
  const exported = await pending;
  const file = test.info().outputPath('notes.json');
  await exported.saveAs(file);
  const payload = JSON.parse(await readFile(file, 'utf8'));
  expect(payload.notes).toHaveLength(1);
  expect(payload.notes[0]).toMatchObject({
    schemaVersion: 1,
    text: 'Edited: segmentation, Zarr, StarDist.',
    source: 'manual',
    modelId: 'manual',
    selectedCellIds: [cellId],
    plane: { channels: [42], z: 0, t: 0 },
  });
  expect(payload.notes[0].imageId).toContain('10501752.zarr');
  expect(payload.notes[0].samplingSeed).toBeTruthy();
  expect(payload.notes[0].contextCapturedAt).toBeTruthy();
  expect(payload.notes[0].settingsJson).toBeTruthy();
  expect(payload.notes[0]).not.toHaveProperty('audio');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.voice-delete').click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(0);
  await page.locator('#voice-close').click();
  await page.reload();
  await page.locator('#voice-all').click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(0);
  expect(asrRequests).toEqual([]);
  expect(network.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test('manual draft works with denied microphone and blocked IndexedDB; export remains available', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    });
    Object.defineProperty(globalThis, 'indexedDB', { get: () => undefined });
  });
  await page.goto('/');
  await expect(page.locator('#csv')).toBeEnabled({ timeout: 45000 });
  await page.locator('#voice-all').click();
  await page.locator('#voice-record').click();
  await expect(page.locator('#voice-status')).toContainText(/permission|denied|microphone/i);
  await page.locator('#voice-text').fill('Manual note without microphone or storage.');
  await page.locator('#voice-save').click();
  await expect(page.locator('#voice-status')).toContainText(/storage|unavailable/i);
  await expect(page.locator('#voice-text')).toHaveValue(
    'Manual note without microphone or storage.',
  );
  const download = page.waitForEvent('download');
  await page.locator('#voice-export-draft').click();
  expect((await download).suggestedFilename()).toContain('.json');
});

test('real IndexedDB transactions isolate snapshots and report CRUD only after commit', async ({
  page,
}) => {
  await page.goto('/?target=invalid');
  const answer = await page.evaluate(async () => {
    const path = '/src/voice/notes-store.ts';
    const { NotesStore, createNote, snapshotContext } = await import(path);
    const name = 'voice-test-' + crypto.randomUUID();
    const store = new NotesStore(name);
    const context = { imageId: 'image-a', selectedCellIds: ['cell-a'] };
    const note = createNote(snapshotContext(context), 'stored text');
    context.imageId = 'image-b';
    context.selectedCellIds[0] = 'cell-b';
    await store.put(note);
    store.close();
    const reopened = new NotesStore(name);
    const saved = await reopened.list();
    await reopened.delete(note.id);
    const remaining = await reopened.list();
    reopened.close();
    return { saved, remaining };
  });
  expect(answer.saved).toHaveLength(1);
  expect(answer.saved[0]).toMatchObject({
    imageId: 'image-a',
    selectedCellIds: ['cell-a'],
    text: 'stored text',
  });
  expect(answer.remaining).toEqual([]);
});
