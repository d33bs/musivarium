import { describe, it, expect } from 'vitest';
import { parseNgff, selectionForRegion, validateLabelAlignment } from '../src/sources/browser';
const attributes = {
  ome: {
    version: '0.5',
    multiscales: [
      {
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'z', type: 'space', unit: 'micrometer' },
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: [
          { path: 's0', coordinateTransformations: [{ type: 'scale', scale: [1, 2, 0.5, 0.5] }] },
        ],
      },
    ],
    omero: { channels: [{ label: 'DNA', color: '0000FF' }] },
  },
};
describe('bounded NGFF single-plane reader', () => {
  it('handles v0.5 metadata and preserves axes, channels and scale', () => {
    const metadata = parseNgff(attributes);
    expect(metadata.axes.map((a) => a.name)).toEqual(['c', 'z', 'y', 'x']);
    expect(metadata.levels[0]).toEqual({
      path: 's0',
      scale: [1, 2, 0.5, 0.5],
      translation: [0, 0, 0, 0],
    });
    expect(metadata.channels[0].name).toBe('DNA');
  });
  it('selects one explicit z and t, bounded xy, one native channel', () => {
    expect(
      selectionForRegion(['t', 'c', 'z', 'y', 'x'], [2, 3, 20, 1000, 2000], {
        x: 10,
        y: 20,
        width: 32,
        height: 64,
        z: 5,
        t: 1,
        channel: 2,
      }),
    ).toEqual([1, 2, 5, { start: 20, stop: 84, step: 1 }, { start: 10, stop: 42, step: 1 }]);
    expect(() =>
      selectionForRegion(['y', 'x'], [40, 40], {
        x: 35,
        y: 0,
        width: 10,
        height: 5,
        z: 0,
        t: 0,
        channel: 0,
      }),
    ).toThrow(/bounds/);
    expect(() =>
      selectionForRegion(['z', 'y', 'x'], [2, 40, 40], {
        x: 0,
        y: 0,
        width: 5,
        height: 5,
        z: 4,
        t: 0,
        channel: 0,
      }),
    ).toThrow(/bounds/);
  });
  it('refuses unaligned label rasters instead of silently scaling', () => {
    expect(() =>
      validateLabelAlignment(
        { axes: ['z', 'y', 'x'], shape: [2, 40, 40], scale: [1, 0.5, 0.5], translation: [0, 0, 0] },
        { axes: ['z', 'y', 'x'], shape: [2, 20, 20], scale: [1, 1, 1], translation: [0, 0, 0] },
      ),
    ).toThrow(/align/);
  });
});
