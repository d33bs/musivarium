import { test, expect } from '@playwright/test';
import { installIdrFixtures } from './support/idr-fixtures';

// Protocol controls isolate editor/error behavior; real ASR is exercised by the
// reproducible speech benchmark, not represented by this synthetic worker.
async function controls(
  page: import('@playwright/test').Page,
  mode: 'result' | 'error' | 'hang' | 'empty',
) {
  await page.addInitScript((mode) => {
    const media: MediaStream[] = [];
    Object.defineProperty(globalThis, '__voiceTracks', {
      get: () => media.flatMap((s) => s.getTracks().map((t) => t.readyState)),
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const context = new AudioContext({ sampleRate: 44100 });
        await context.resume();
        const oscillator = context.createOscillator(),
          destination = context.createMediaStreamDestination();
        oscillator.frequency.value = 440;
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
        media.push(destination.stream);
        return destination.stream;
      },
    });
    const RealWorker = globalThis.Worker;
    let terminated = 0;
    Object.defineProperty(globalThis, '__voiceTerminated', { get: () => terminated });
    globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
      if (!String(url).includes('asr.worker')) return new RealWorker(url, options);
      return new (class extends EventTarget {
        onmessage?: (event: { data: unknown }) => void;
        onerror = null;
        onmessageerror = null;
        timer?: ReturnType<typeof setTimeout>;
        postMessage(data: { id: number; samples: Float32Array }) {
          const samples = structuredClone(data.samples, {
            transfer: [data.samples.buffer as ArrayBuffer],
          });
          if (samples.length < 4000) throw Error('Test capture too short');
          this.onmessage?.({
            data: {
              type: 'progress',
              id: data.id,
              progress: { status: 'transcribing', message: 'Transcribing local protocol control…' },
            },
          });
          if (mode === 'hang') return;
          this.timer = setTimeout(
            () =>
              this.onmessage?.({
                data:
                  mode === 'error'
                    ? {
                        type: 'error',
                        id: data.id,
                        message: 'Model download failed. Retry or use manual text.',
                      }
                    : {
                        type: 'result',
                        id: data.id,
                        result: {
                          text: mode === 'empty' ? '' : 'Protocol control: nucleus and cytoplasm.',
                          modelId: 'onnx-community/whisper-tiny.en',
                          modelRevision: 'protocol-control',
                          loadMs: 1,
                          transcriptionMs: 1,
                        },
                      },
              }),
            50,
          );
        }
        terminate() {
          clearTimeout(this.timer);
          terminated++;
        }
      })();
    } as unknown as typeof Worker;
  }, mode);
}

async function record(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.locator('#csv')).toBeEnabled({ timeout: 45000 });
  const cell = await page.locator('.object-tile').first().getAttribute('data-id');
  await page.locator('.tile-voice-notes').first().click();
  await page.locator('#voice-record').click();
  await expect(page.locator('#voice-stop')).toBeVisible();
  await expect
    .poll(async () => parseFloat((await page.locator('#voice-elapsed').textContent()) ?? '0'))
    .toBeGreaterThan(0.5);
  await page.locator('#voice-stop').click();
  return cell;
}

test('real worklet capture feeds worker protocol, editable transcript saves captured tile context', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  await controls(page, 'result');
  const cell = await record(page);
  await expect(page.locator('#voice-text')).toHaveValue('Protocol control: nucleus and cytoplasm.');
  expect(
    await page.evaluate(() => (globalThis as unknown as { __voiceTracks: string[] }).__voiceTracks),
  ).toEqual(['ended']);
  expect(
    await page.evaluate(
      () => (globalThis as unknown as { __voiceTerminated: number }).__voiceTerminated,
    ),
  ).toBe(1);
  // A later form/selection change must not alter the snapshot taken on Record.
  await page.evaluate(() => {
    (document.querySelector('#z') as HTMLInputElement).value = '2';
    (document.querySelector('#seed') as HTMLInputElement).value = 'later-seed';
  });
  await page.locator('#voice-text').fill('Corrected nucleus and cytoplasm.');
  await page.locator('#voice-save').click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(1);
  const stored = await page.evaluate(async () => {
    const path = '/src/voice/notes-store.ts';
    return new (await import(path)).NotesStore().list();
  });
  expect(stored[0]).toMatchObject({
    selectedCellIds: [cell],
    plane: { z: 0 },
    source: 'local-whisper',
    rawTranscript: 'Protocol control: nucleus and cytoplasm.',
    text: 'Corrected nucleus and cytoplasm.',
  });
  expect(stored[0].samplingSeed).not.toBe('later-seed');
});

test('failed model leaves crop exports and manual notes functional; retry is available', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  await controls(page, 'error');
  await record(page);
  await expect(page.locator('#voice-status')).toContainText('Model download failed');
  await expect(page.locator('#voice-retry')).toBeVisible();
  await page.locator('#voice-text').fill('Typed after model failure.');
  await page.locator('#voice-save').click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(1);
  await page.locator('#voice-close').click();
  await expect(page.locator('#csv')).toBeEnabled();
  await page.locator('.object-tile').first().click();
  await expect(page.locator('#inspector')).toBeVisible();
});

test('cancel during local inference terminates worker and allows a fresh note', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  await controls(page, 'hang');
  await record(page);
  await expect(page.locator('#voice-status')).toContainText('Transcribing local protocol');
  await page.locator('#voice-cancel').click();
  await expect(page.locator('#voice-status')).toContainText('cancelled');
  expect(
    await page.evaluate(
      () => (globalThis as unknown as { __voiceTerminated: number }).__voiceTerminated,
    ),
  ).toBe(1);
  await expect(page.locator('#voice-record')).toBeEnabled();
  await page.locator('#voice-text').fill('Manual text after cancellation.');
  await page.locator('#voice-save').click();
  await expect(page.locator('.voice-saved-note')).toHaveCount(1);
});

for (const mode of ['error', 'empty'] as const) {
  test(`${mode} ASR retains an unsaved recording until discard is confirmed`, async ({
    page,
    context,
  }) => {
    await installIdrFixtures(context);
    await controls(page, mode);
    await record(page);
    await expect(page.locator('#voice-retry')).toBeVisible();
    await expect(page.locator('#voice-text')).toHaveValue('');
    for (const button of ['voice-close', 'voice-new', 'voice-record']) {
      page.once('dialog', (dialog) => dialog.dismiss());
      await page.locator('#' + button).click();
      await expect(page.locator('#voice-notes-dialog')).toBeVisible();
      await expect(page.locator('#voice-retry')).toBeVisible();
    }
    const protectedNavigation = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(protectedNavigation).toBe(true);
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#voice-close').click();
    await expect(page.locator('#voice-notes-dialog')).toBeHidden();
    expect(
      await page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(false);
  });
}
