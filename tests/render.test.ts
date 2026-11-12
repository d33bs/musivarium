import { describe, it, expect } from 'vitest';
import { composite, outline, seededOrder } from '../src/render';
it('composites selected native channel colors and exact boundaries', () => {
  const rgba = composite([Uint16Array.from([0, 100, 200, 0])], 2, 2, ['FF0000'], [[0, 200]]);
  expect(Array.from(rgba)).toEqual([0, 0, 0, 255, 128, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255]);
  expect(Array.from(outline(Uint32Array.from([0, 7, 7, 0]), 2, 2, 7))).toEqual([0, 1, 1, 0]);
  expect(Array.from(outline(Uint32Array.from([3, 7, 3, 0]), 2, 2, 7))).toEqual([0, 1, 0, 0]);
});
it('shuffles reproducibly without mutating records', () => {
  const a = [{ cell_id: 'a' }, { cell_id: 'b' }, { cell_id: 'c' }];
  expect(seededOrder(a, '42')).toEqual(seededOrder(a, '42'));
  expect(a.map((c) => c.cell_id)).toEqual(['a', 'b', 'c']);
});
