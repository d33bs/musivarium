import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fixtureManifest } from './support/idr-fixtures';
import { installIdrFixtures } from './support/idr-fixtures';
test('the selected instance is outlined by default in each crop', async ({ page, context }) => {
  await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', { timeout: 15000 });
  await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  await expect(page.locator('#overlay')).toBeChecked();
  const green = () =>
    page
      .locator('#mosaic canvas')
      .first()
      .evaluate((canvas: HTMLCanvasElement) => {
        const p = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let n = 0;
        for (let i = 0; i < p.length; i += 4)
          if (p[i] === 0 && p[i + 1] === 255 && p[i + 2] === 0) n++;
        return n;
      });
  expect(await green()).toBeGreaterThan(0);
  await page.locator('#overlay').uncheck();
  expect(await green()).toBe(0);
});
test('a streamed original image advances the progress bar before a tile finishes', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  const folder = new URL('./fixtures/idr0076/', import.meta.url),
    entries = new Map(
      fixtureManifest.entries.map((e) => [
        e.key,
        { ...e, body: readFileSync(new URL(e.file, folder)) },
      ]),
    );
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (started = r));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname,
      key = path.replace(/^\/image.zarr\//, '');
    const entry = entries.get(key);
    if (!entry) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }).end();
      return;
    }
    res.writeHead(entry.status, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': entry.contentType,
      'Content-Length': entry.body.length,
    });
    if (key === '0/42/0/0') {
      res.write(entry.body.subarray(0, 65536));
      started();
      await gate;
      res.end(entry.body.subarray(65536));
    } else res.end(entry.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await page.goto('/?source=' + encodeURIComponent(`http://127.0.0.1:${port}/image.zarr/`));
    await seen;
    await expect(page.locator('#read-summary')).toContainText('received');
    await expect
      .poll(() =>
        page
          .locator('#progress')
          .evaluate(
            (p: HTMLProgressElement) => p.hasAttribute('value') && p.value > 0 && p.value < 1,
          ),
      )
      .toBe(true);
    await expect(page.locator('#result-count')).not.toHaveText('100 of 100 objects');
    await expect(page.locator('#cancel')).toBeEnabled();
    const elapsed = await page.locator('#read-elapsed').textContent();
    await expect.poll(() => page.locator('#read-elapsed').textContent()).not.toBe(elapsed);
    release();
    await expect(page.locator('#result-count')).toHaveText('100 of 100 objects', {
      timeout: 15000,
    });
    await expect(page.locator('#progress')).toBeHidden();
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
