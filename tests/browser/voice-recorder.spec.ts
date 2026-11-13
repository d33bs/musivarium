import { expect, test } from '@playwright/test';
import { fakeMicrophoneWav } from './support/voice-device';
import type {} from './support/voice-recorder-harness';

// Real AudioContext/AudioWorklet/Worker, simulated browser microphone device.
// This does NOT claim to test a physical microphone or human speech recognition.
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${fakeMicrophoneWav()}`,
      '--disable-audio-track-processing',
    ],
    firefoxUserPrefs: {
      'media.navigator.streams.fake': true,
      'media.navigator.permission.disabled': true,
      'media.autoplay.default': 0,
    },
  },
});

test.beforeEach(async ({ page, baseURL }) => {
  const root = `${baseURL!.replace(/\/$/, '')}/`;
  await page.goto(new URL('tests/browser/support/voice-recorder.html', root).href);
  await page.waitForFunction(() => !!window.voiceHarness);
});

for (const rate of [44100, 48000]) {
  test(`fake-device ${rate} Hz microphone → real worklet → 16-kHz WAV, with full cleanup`, async ({
    page,
  }) => {
    await page.evaluate((rate) => {
      window.voiceHarness.rate = rate;
    }, rate);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.voiceHarness.status)).toBe('recording');
    await expect
      .poll(() => page.evaluate(() => window.voiceHarness.progress.at(-1) ?? 0))
      .toBeGreaterThan(0.8);
    const result = await page.evaluate(() => window.voiceHarness.stop());
    expect(result.sampleRate).toBe(16000);
    expect(result.durationSeconds).toBeGreaterThan(0.8);
    expect(result.length).toBe(Math.round(result.durationSeconds * 16000));
    expect(result.rms).toBeGreaterThan(0.01);
    expect(result.contextRate).toBe(rate);
    expect(result.tracks).toEqual(['ended']);
    expect(result.contexts).toEqual(['closed']);
    expect(result.workers).toEqual([true]);
    expect(result.wavRate).toBe(16000);
    expect(result.wavChannels).toBe(1);
    expect(result.wavDuration).toBeCloseTo(result.durationSeconds, 3);
    expect(await page.evaluate(() => window.voiceHarness.errors)).toEqual([]);
  });
}

test('discard/pagehide releases a real fake-device track and permits another capture', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.voiceHarness.status)).toBe('recording');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(
    await page.evaluate(() => window.voiceHarness.tracks.map((track) => track.readyState)),
  ).toEqual(['ended']);
  await expect
    .poll(() => page.evaluate(() => window.voiceHarness.contexts.map((context) => context.state)))
    .toEqual(['closed']);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.voiceHarness.status)).toBe('recording');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.voiceHarness.tracks.every((track) => track.readyState === 'ended'),
    ),
  ).toBe(true);
});

test('discard invalidates a pending permission result and stops its late real track', async ({
  page,
}) => {
  await page.evaluate(() => {
    window.voiceHarness.holdPermission = true;
  });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.voiceHarness.tracks.length)).toBe(1);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.evaluate(() => window.voiceHarness.releasePermission());
  await expect
    .poll(() => page.evaluate(() => window.voiceHarness.tracks[0].readyState))
    .toBe('ended');
  expect(await page.evaluate(() => window.voiceHarness.contexts.length)).toBe(0);
  expect(await page.evaluate(() => window.voiceHarness.errors)).toEqual([]);
});

for (const rate of [44100, 48000]) {
  test(`real worklet offline DSP enforces exactly 90 seconds at ${rate} Hz without UI timers`, async ({
    page,
  }) => {
    const result = await page.evaluate((rate) => window.voiceHarness.offlineLimit(rate), rate);
    expect(result.frames).toBe(rate * 90);
    expect(result.limit).toBe(true);
    expect(result.doneCount).toBe(1);
    expect(result.progressAt80).toBe(true);
    expect(result.outputIsSilent).toBe(true);
  });
}

test('90-second preparation runs in a real worker while the UI keeps ticking', async ({ page }) => {
  const result = await page.evaluate(() => window.voiceHarness.longPreparation());
  expect(result.sampleRate).toBe(16000);
  expect(result.frames).toBe(16000 * 90);
  expect(result.ticks).toBeGreaterThan(1);
  expect(result.transferred).toBe(true);
});
