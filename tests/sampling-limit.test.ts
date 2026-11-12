import { it, expect } from 'vitest';
import { runPipeline } from '../src/pipeline';
import { DEFAULT_SETTINGS } from '../src/core';
it('honors target, randomizes object selection, scopes ids and publishes bounded batches', async () => {
  const source = {
    metadata: {
      axes: [{ name: 'y' }, { name: 'x' }],
      levels: [{ path: '0', scale: [1, 1], translation: [0, 0] }],
      channels: [],
      labels: [],
      version: '0.4',
    },
    stats: { requests: 0, bytes: 0, cacheHits: 0, objects: [] },
    alignment: async () => ({
      axes: ['y', 'x'],
      shape: [128, 128],
      scale: [1, 1],
      translation: [0, 0],
    }),
    readRegion: async () => {
      const p = new Uint16Array(128 * 128);
      for (let i = 0; i < 10; i++) p[(10 + i * 10) * 128 + 10] = 100;
      return p;
    },
  };
  const settings = {
    ...DEFAULT_SETTINGS,
    source: 'https://example.org/a',
    channels: [0],
    segmentChannel: 0,
    segmentation: 'classical' as const,
    tile: 128,
    count: 1,
    target: 3,
    minArea: 1,
    cropSize: 16,
    padding: 0,
  };
  const batches: any[] = [];
  const a = await runPipeline(settings, {
    source,
    signal: new AbortController().signal,
    onBatch: (b) => batches.push(b),
  });
  expect(a.cells).toHaveLength(3);
  expect(batches).toHaveLength(1);
  expect(batches[0].cells).toHaveLength(3);
  expect(a.cells.map((c) => c.label)).not.toEqual([1, 2, 3]);
  const b = await runPipeline(
    { ...settings, source: 'https://example.org/b' },
    { source, signal: new AbortController().signal },
  );
  expect(b.cells[0].cell_id).not.toBe(a.cells[0].cell_id);
  expect(a.cells[0].crop.width).toBe(16);
  expect(a.cells[0]).toHaveProperty('region_x', 0);
});
