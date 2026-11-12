import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSource } from '../src/sources/browser';
import { drawCrop } from '../src/render';
import type { Cell } from '../src/pipeline';
afterEach(() => vi.unstubAllGlobals());
// Deliberately synthetic numeric arrays test axis mechanics only, not microscopy quality.
it('reads XY from XTYCZ order while fetching only the selected T/C/Z chunks', async () => {
  const fetched: string[] = [];
  const axes = ['x', 't', 'y', 'c', 'z'];
  vi.stubGlobal('fetch', async (request: Request) => {
    const path = new URL(request.url).pathname;
    fetched.push(path);
    if (path.endsWith('/test.zarr/zarr.json'))
      return Response.json({
        zarr_format: 3,
        node_type: 'group',
        attributes: {
          ome: {
            version: '0.5',
            multiscales: [
              {
                axes: axes.map((name) => ({ name })),
                datasets: [
                  {
                    path: '0',
                    coordinateTransformations: [{ type: 'scale', scale: [0.5, 1, 2, 1, 4] }],
                  },
                ],
              },
            ],
          },
        },
      });
    if (path.endsWith('/0/zarr.json'))
      return Response.json({
        zarr_format: 3,
        node_type: 'array',
        shape: [4, 2, 3, 2, 2],
        data_type: 'uint16',
        dimension_names: axes,
        chunk_grid: { name: 'regular', configuration: { chunk_shape: [2, 1, 3, 1, 1] } },
        chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
        fill_value: 0,
        codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
        attributes: {},
      });
    const match = path.match(/\/0\/c\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/);
    if (match) {
      const [x, t, y, c, z] = match.slice(1).map(Number),
        bytes = new Uint8Array(12),
        view = new DataView(bytes.buffer);
      let i = 0;
      for (let xx = 0; xx < 2; xx++)
        for (let yy = 0; yy < 3; yy++)
          view.setUint16(
            i++ * 2,
            1000 * t + 100 * c + 10 * z + 3 * (y * 3 + yy) + x * 2 + xx,
            true,
          );
      return new Response(bytes.buffer);
    }
    return new Response(null, { status: 404 });
  });
  const source = await BrowserSource.open(
    'https://example.invalid/test.zarr/',
    new AbortController().signal,
  );
  const pixels = await source.readRegion(0, {
    x: 1,
    y: 1,
    width: 2,
    height: 2,
    t: 1,
    channel: 1,
    z: 1,
  });
  expect(Array.from(pixels)).toEqual([1114, 1115, 1117, 1118]);
  const chunks = fetched.filter((path) => path.includes('/0/c/'));
  expect(chunks).toHaveLength(2);
  expect(chunks.every((path) => /\/0\/c\/[01]\/1\/0\/1\/1$/.test(path))).toBe(true);
});
it('preserves nonsquare physical pixel aspect in the actual crop renderer', () => {
  const calls: unknown[][] = [];
  const context = {
    fillStyle: '',
    fillRect: () => {},
    imageSmoothingEnabled: true,
    drawImage: (...args: unknown[]) => calls.push(args),
  };
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData: () => {} }) }),
  });
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(..._args: unknown[]) {}
    },
  );
  const cell = {
    crop: { width: 2, height: 2, channels: [Uint16Array.from([0, 1, 2, 3])] },
    scale_x: 0.5,
    scale_y: 2,
    label: 1,
    mask: Uint32Array.from([1, 1, 1, 1]),
  } as unknown as Cell;
  drawCrop(
    { getContext: () => context } as unknown as HTMLCanvasElement,
    cell,
    ['FFFFFF'],
    false,
    100,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].slice(1)).toEqual([39, 6, 22, 88]);
});
