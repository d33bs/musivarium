import { describe, it, expect } from 'vitest';
import { runPipeline } from '../src/pipeline';
import { DEFAULT_SETTINGS } from '../src/core';
const metadata = {
  axes: [{ name: 'y' }, { name: 'x' }],
  levels: [{ path: '0', scale: [1, 1], translation: [0, 0] }],
  channels: [{ name: 'DNA', color: 'FFFFFF' }],
  labels: [],
  version: '0.4',
};
function fixture() {
  return {
    metadata,
    stats: { requests: 1, bytes: 32, cacheHits: 0, objects: [] },
    alignment: async () => ({
      axes: ['y', 'x'],
      shape: [128, 128],
      scale: [1, 1],
      translation: [0, 0],
    }),
    readRegion: async (_level: number, r: { width: number; height: number }) => {
      const pixels = new Uint16Array(r.width * r.height);
      for (let y = 30; y < 40; y++) for (let x = 30; x < 40; x++) pixels[y * r.width + x] = 1000;
      return pixels;
    },
  };
}
describe('sampling to single-object crops', () => {
  it('uses the requested channels/plane and emits deterministic raw measurements with provenance', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      source: 'https://example.org/image',
      segmentation: 'classical' as const,
      channels: [0],
      segmentChannel: 0,
      tile: 128,
      count: 1,
      minArea: 4,
    };
    const a = await runPipeline(settings, {
      source: fixture(),
      signal: new AbortController().signal,
    });
    expect(a.cells).toHaveLength(1);
    expect(a.cells[0]).toMatchObject({
      area: 100,
      means: [1000],
      z: 0,
      t: 0,
      level: 0,
      segmentation: 'classical',
      reader: 'duckdb-zarr',
    });
    expect(a.cells[0].crop.channels[0]).toBeInstanceOf(Uint16Array);
    expect(a.cells[0].cell_id).toBe(
      (await runPipeline(settings, { source: fixture(), signal: new AbortController().signal }))
        .cells[0].cell_id,
    );
  });
  it('honors cancellation before touching data', async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      runPipeline({ ...DEFAULT_SETTINGS }, { source: fixture(), signal: c.signal }),
    ).rejects.toThrow();
  });
});
