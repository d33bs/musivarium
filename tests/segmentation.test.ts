import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  normalizePercentile,
  segmentClassical,
  segmentModel,
  decodeStarDist,
} from '../src/segmentation/index';

describe('classical segmentation', () => {
  it('labels disconnected bright objects deterministically with compact IDs', () => {
    const pixels = new Uint16Array([0, 10, 10, 0, 0, 0, 10, 10, 0, 20, 0, 0, 0, 0, 20]);
    expect([...segmentClassical(pixels, 5, 3, { threshold: 5, minArea: 2 })]).toEqual([
      0, 1, 1, 0, 0, 0, 1, 1, 0, 2, 0, 0, 0, 0, 2,
    ]);
  });
  it('uses Otsu by default and removes small objects', () => {
    expect([...segmentClassical(new Uint8Array([0, 0, 100, 100]), 4, 1)]).toEqual([0, 0, 1, 1]);
    expect([
      ...segmentClassical(new Uint8Array([0, 8, 0, 0, 8, 8]), 6, 1, { threshold: 1, minArea: 2 }),
    ]).toEqual([0, 0, 0, 0, 1, 1]);
  });
  it('returns background on constant input, handles diagonal connectivity, never mutates pixels', () => {
    expect([...segmentClassical(new Float32Array(4).fill(5), 2, 2)]).toEqual([0, 0, 0, 0]);
    const input = new Uint8Array([9, 0, 0, 9]);
    expect([...segmentClassical(input, 2, 2, { threshold: 1 })]).toEqual([1, 0, 0, 1]);
    expect([...input]).toEqual([9, 0, 0, 9]);
  });
  it('rejects mismatched sizes, invalid options and nonfinite intensities', () => {
    expect(() => segmentClassical(new Uint8Array(3), 2, 2)).toThrow(/dimensions/);
    expect(() => segmentClassical(new Uint8Array(4), 0, 2)).toThrow(/dimensions/);
    expect(() => segmentClassical(new Uint8Array(4), 2, 2, { minArea: 0 })).toThrow(/minArea/);
    expect(() => segmentClassical(new Float32Array([NaN]), 1, 1)).toThrow(/finite/);
    expect(() => segmentClassical(new Uint8Array(1), 1, 1, { threshold: NaN })).toThrow(
      /threshold/,
    );
  });
});

describe('pretrained model contract', () => {
  const modelPath = resolve('public/models/stardist-dsb2018.onnx');
  it.runIf(existsSync(modelPath))(
    'runs the checksum-verified neural graph on CPU/WASM (not threshold fallback)',
    async () => {
      const bytes = new Uint8Array(readFileSync(modelPath));
      const labels = await segmentModel(new Uint8Array(32 * 32), 32, 32, { modelBytes: bytes });
      expect(labels).toBeInstanceOf(Uint32Array);
      expect(labels.length).toBe(32 * 32);
      expect(new Set(labels)).toEqual(new Set([0]));
      const corrupted = bytes.slice();
      corrupted[0] = corrupted[0]! ^ 1;
      await expect(
        segmentModel(new Uint8Array(16 * 16), 16, 16, { modelBytes: corrupted }),
      ).rejects.toThrow(/SHA-256/);
    },
    30_000,
  );

  it.runIf(Boolean(process.env.SEGMENTATION_BENCHMARK_DIR))(
    'benchmarks real microscopy against its reference mask',
    async () => {
      const directory = process.env.SEGMENTATION_BENCHMARK_DIR!;
      const pixelBuffer = readFileSync(resolve(directory, 'image.f32'));
      const referenceBuffer = readFileSync(resolve(directory, 'labels.u32'));
      const pixels = new Float32Array(
        pixelBuffer.buffer.slice(
          pixelBuffer.byteOffset,
          pixelBuffer.byteOffset + pixelBuffer.length,
        ),
      );
      const reference = new Uint32Array(
        referenceBuffer.buffer.slice(
          referenceBuffer.byteOffset,
          referenceBuffer.byteOffset + referenceBuffer.length,
        ),
      );
      const side = Math.sqrt(pixels.length);
      const bytes = new Uint8Array(readFileSync(modelPath));
      const start = performance.now();
      const learned = await segmentModel(pixels, side, side, { modelBytes: bytes, minArea: 8 });
      const coldMs = performance.now() - start;
      const classicalStart = performance.now();
      const classical = segmentClassical(pixels, side, side, { minArea: 8 });
      const classicalMs = performance.now() - classicalStart;
      const metrics = (labels: Uint32Array) => {
        let intersection = 0,
          union = 0;
        for (let i = 0; i < labels.length; i++) {
          if (labels[i] && reference[i]) intersection++;
          if (labels[i] || reference[i]) union++;
        }
        return { instances: new Set(labels).size - 1, foregroundIoU: intersection / union };
      };
      console.log(
        JSON.stringify({
          fixture: 'stardist/tests/data/img2d.tif',
          shape: [side, side],
          referenceInstances: new Set(reference).size - 1,
          model: { ...metrics(learned), coldMs },
          classical: { ...metrics(classical), ms: classicalMs },
        }),
      );
      expect(metrics(learned).instances).toBeGreaterThan(10);
      expect(metrics(learned).foregroundIoU).toBeGreaterThan(0.4);
    },
    120_000,
  );

  it('uses 1st/99.8th percentile normalization, preserving unclipped values', () => {
    const input = Float32Array.from({ length: 101 }, (_, i) => i);
    const result = normalizePercentile(input);
    expect(result[1]).toBeCloseTo(0);
    expect(result[100]).toBeCloseTo(99 / 98.8);
    expect(result[0]).toBeLessThan(0);
    expect(input[100]).toBe(100);
    expect([...normalizePercentile(new Uint8Array(3).fill(2))]).toEqual([0, 0, 0]);
  });
  it('rejects already-cancelled model requests before loading any weights', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      segmentModel(new Uint8Array(4), 2, 2, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('decodes learned radial distances into distinct instance masks with NMS', () => {
    // NHWC output, probability + 32 positive ray distances on a half-resolution grid.
    const data = new Float32Array(8 * 8 * 33);
    const setCandidate = (x: number, y: number, probability: number) => {
      const index = (y * 8 + x) * 33;
      data[index] = probability;
      data.fill(3, index + 1, index + 33);
    };
    setCandidate(2, 2, 0.9);
    setCandidate(2, 3, 0.8); // overlapping lower-probability polygon suppressed
    setCandidate(6, 6, 0.95);
    const labels = decodeStarDist(data, 8, 8, 16, 16, { minArea: 1 });
    expect(labels).toBeInstanceOf(Uint32Array);
    expect(new Set(labels)).toEqual(new Set([0, 1, 2]));
    expect(labels[4 * 16 + 4]).toBeGreaterThan(0);
    expect(labels[12 * 16 + 12]).toBeGreaterThan(0);
    expect(labels[4 * 16 + 4]).not.toBe(labels[12 * 16 + 12]);
  });
});
