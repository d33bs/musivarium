import { test, expect } from '@playwright/test';
import { installIdrFixtures } from './support/idr-fixtures';
test('crop and inspector images use grayscale with green focused-instance contours', async ({
  page,
  context,
}) => {
  await installIdrFixtures(context);
  await page.goto('/');
  await expect(page.locator('#raw')).toBeEnabled({ timeout: 15000 });
  const inspectPixels = async (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas
          .getContext('2d')!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let green = 0,
          otherColor = 0,
          brightGray = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i],
            g = pixels[i + 1],
            b = pixels[i + 2];
          if (r === 0 && g === 255 && b === 0) green++;
          else if (r === g && g === b) {
            if (r > 30) brightGray++;
          } else if (!(r === b && g > r)) otherColor++;
        }
        return { green, otherColor, brightGray };
      });
  let colors = await inspectPixels('#mosaic canvas');
  expect(colors.otherColor).toBe(0);
  expect(colors.green).toBeGreaterThan(0);
  expect(colors.brightGray).toBeGreaterThan(0);
  await page.locator('#mosaic [role=gridcell]').first().click();
  colors = await inspectPixels('#inspector-canvas');
  expect(colors.otherColor).toBe(0);
  expect(colors.green).toBeGreaterThan(0);
  await page.locator('#close').click();
  await page.getByRole('button', { name: 'Show settings', exact: true }).click();
  await page.locator('#overlay').uncheck();
  colors = await inspectPixels('#mosaic canvas');
  expect(colors.green).toBe(0);
  expect(colors.otherColor).toBe(0);
});
