import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runPipeline, type ImageSource } from '../src/pipeline';
import { DEFAULT_SETTINGS, type Pixels } from '../src/core';
it('overlaps image pixels with label metadata, then reads the aligned mask concurrently', async () => {
  const folder = new URL('./fixtures/idr0076-10501752/', import.meta.url),
    ib = readFileSync(new URL('image-c42.f64le', folder)),
    lb = readFileSync(new URL('labels.i16le', folder));
  const image = Float64Array.from({ length: 4096 }, (_, i) => ib.readDoubleLE(i * 8)),
    labels = Uint32Array.from({ length: 4096 }, (_, i) => lb.readInt16LE(i * 2));
  let releaseMetadata!: () => void,
    releaseData!: () => void,
    imageStarted = false,
    labelMetadataStarted = false,
    labelPixelsStarted = false;
  const metadataGate = new Promise<void>((r) => (releaseMetadata = r)),
    dataGate = new Promise<void>((r) => (releaseData = r));
  function adapter(pixels: Pixels, isLabel: boolean): ImageSource {
    return {
      metadata: {
        version: '0.4',
        axes: [{ name: 'c' }, { name: 'y' }, { name: 'x' }],
        levels: [{ path: '0', scale: [1, 1, 1], translation: [0, 0, 0] }],
        channels: [],
        labels: ['0'],
      },
      stats: { requests: 0, bytes: 0, cacheHits: 0, objects: [] },
      async alignment() {
        if (isLabel) {
          labelMetadataStarted = true;
          await metadataGate;
        }
        return {
          axes: ['c', 'y', 'x'],
          shape: [isLabel ? 1 : 50, 64, 64],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        };
      },
      async readRegion() {
        if (isLabel) labelPixelsStarted = true;
        else imageStarted = true;
        await dataGate;
        return pixels;
      },
    };
  }
  const pending = runPipeline(
    { ...DEFAULT_SETTINGS, tile: 128, count: 1, target: 3, minArea: 1 },
    {
      signal: new AbortController().signal,
      source: adapter(image, false),
      labels: adapter(labels, true),
    },
  );
  try {
    await vi.waitFor(() => expect(imageStarted).toBe(true));
    expect(labelMetadataStarted).toBe(true);
    releaseMetadata();
    await vi.waitFor(() => expect(labelPixelsStarted).toBe(true));
    releaseData();
    expect((await pending).cells).toHaveLength(3);
  } finally {
    releaseMetadata();
    releaseData();
    await pending;
  }
});
