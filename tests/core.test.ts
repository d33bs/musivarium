import { describe, it, expect } from 'vitest';
import {
  sampleWindows,
  extractObjects,
  cropObject,
  normalize,
  parseSettings,
  settingsUrl,
  DEFAULT_SETTINGS,
} from '../src/core';

describe('single-plane sampling', () => {
  it('is repeatable, in bounds, exhaustive without duplicate tiles', () => {
    const a = sampleWindows(1000, 700, 256, 6, '42');
    expect(a).toEqual(sampleWindows(1000, 700, 256, 6, '42'));
    expect(new Set(a.map((r) => `${r.x},${r.y}`)).size).toBe(6);
    for (const r of a) {
      expect(r.x + r.width).toBeLessThanOrEqual(1000);
      expect(r.y + r.height).toBeLessThanOrEqual(700);
    }
    expect(() => sampleWindows(100, 100, 256, 2, '42')).toThrow(/available/);
  });
});
describe('native measurements and clipped crops', () => {
  it('uses numeric labels, native pixels, global coordinates and edge flags', () => {
    const mask = Uint32Array.from([0, 7, 7, 0, 0, 7, 7, 0, 8, 0, 0, 0]);
    const pixels = Uint16Array.from([0, 10, 20, 0, 0, 30, 40, 0, 9, 0, 0, 0]);
    const objects = extractObjects(mask, [pixels], 4, 3, { x: 100, y: 200 });
    expect(objects).toHaveLength(2);
    expect(objects[0]).toMatchObject({
      label: 7,
      area: 4,
      cx: 101.5,
      cy: 200.5,
      x: 101,
      y: 200,
      width: 2,
      height: 2,
      edge: true,
      means: [25],
    });
    expect(objects[1]).toMatchObject({ label: 8, area: 1, edge: true });
    const crop = cropObject([pixels], 4, 3, objects[0], { x: 100, y: 200 }, 1);
    expect(crop).toMatchObject({ width: 4, height: 3, x: 100, y: 200 });
    expect(Array.from(crop.channels[0])).toEqual(Array.from(pixels));
  });
  it('normalizes only for display without touching native values', () => {
    const raw = Uint16Array.from([10, 20, 30, 40]);
    expect(Array.from(normalize(raw, 10, 40))).toEqual([0, 85, 170, 255]);
    expect(Array.from(raw)).toEqual([10, 20, 30, 40]);
  });
});
describe('reproducible URL state', () => {
  it('round-trips dataset, backend, channels, seed and plane settings', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      source: 'https://example.org/data.zarr/',
      channels: [0, 2],
      segmentChannel: 0,
      z: 3,
      t: 1,
      seed: 'a b',
    };
    expect(parseSettings(settingsUrl(settings, 'https://example.org/app/'))).toEqual(settings);
  });
  it('rejects oversized samples and non-http URLs', () => {
    expect(() => parseSettings('https://example.org/?count=100000')).toThrow(/count/);
    expect(() => parseSettings('https://example.org/?source=javascript%3Aalert(1)')).toThrow(
      /HTTP/,
    );
  });
});
