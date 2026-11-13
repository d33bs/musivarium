import { test, expect } from '@playwright/test';
import { installIdrFixtures } from './support/idr-fixtures';

async function controlWorker(page: import('@playwright/test').Page, text: string) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const context = new AudioContext();
        await context.resume();
        const oscillator = context.createOscillator(),
          destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            oscillator.stop();
            void context.close();
          };
        }
        return destination.stream;
      },
    });
    const RealWorker = globalThis.Worker;
    globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
      if (!String(url).includes('asr.worker')) return new RealWorker(url, options);
      return new (class extends EventTarget {
        onmessage?: (event: { data: unknown }) => void;
        onerror = null;
        onmessageerror = null;
        postMessage(data: { id: number }) {
          setTimeout(
            () =>
              this.onmessage?.({
                data: {
                  type: 'result',
                  id: data.id,
                  result: {
                    text: (globalThis as unknown as { __controlText: string }).__controlText,
                    modelId: 'onnx-community/whisper-tiny.en',
                    modelRevision: 'control',
                    loadMs: 1,
                    transcriptionMs: 1,
                  },
                },
              }),
            20,
          );
        }
        terminate() {}
      })();
    } as unknown as typeof Worker;
  });
  await page.addInitScript((text) => {
    Object.assign(globalThis, { __controlText: text });
  }, text);
}

async function setControlText(page: import('@playwright/test').Page, text: string) {
  await page.evaluate((text) => {
    Object.assign(globalThis, { __controlText: text });
  }, text);
}

test('a real decoder-loop transcript is flagged for review before saving, a normal one is not', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  // Actual repeated phrase recovered from a genuine local Whisper Tiny English
  // hallucination on a 90-second synthetic clip (see docs/voice-asr-quality-investigation.md).
  const looped =
    'Bronze telescope marks the first crossing. ' +
    'The third one was the third one. '.repeat(74) +
    'Plum bicycle marks the final crossing.';
  await controlWorker(page, looped);
  await page.goto('/');
  await page.locator('.tile-voice-notes').first().click();
  await page.locator('#voice-record').click();
  // Wait for the recording phase transition (elapsed resets to 0.0 in the same
  // synchronous block that reveals Stop), so the threshold poll below starts
  // from a guaranteed-fresh baseline instead of a possibly-stale prior value.
  await expect(page.locator('#voice-stop')).toBeVisible();
  await expect
    .poll(async () => parseFloat((await page.locator('#voice-elapsed').textContent()) ?? '0'))
    .toBeGreaterThan(0.5);
  await page.locator('#voice-stop').click();
  await expect(page.locator('#voice-transcript-warning')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#voice-transcript-warning')).toContainText(/repeat/i);
  await expect(page.locator('#voice-save')).toBeEnabled();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#voice-close').click();

  await page.locator('.tile-voice-notes').first().click();
  await setControlText(page, 'Inspect the nucleus and cytoplasm. Review the segmentation outline.');
  await page.locator('#voice-record').click();
  await expect(page.locator('#voice-stop')).toBeVisible();
  await expect
    .poll(async () => parseFloat((await page.locator('#voice-elapsed').textContent()) ?? '0'))
    .toBeGreaterThan(0.5);
  await page.locator('#voice-stop').click();
  await expect(page.locator('#voice-text')).not.toHaveValue('', { timeout: 15000 });
  await expect(page.locator('#voice-transcript-warning')).toBeHidden();
});
