import { it, expect } from 'vitest';
import { npy, validateSelect, provenance } from '../src/exports';
import type { RunResult } from '../src/pipeline';
it('exports typed native plane as a valid NumPy v1 stream', () => {
  const data = npy(Uint16Array.from([1, 256, 65535, 7]), 2, 2);
  expect(Array.from(data.slice(0, 8))).toEqual([147, 78, 85, 77, 80, 89, 1, 0]);
  const length = new DataView(data.buffer).getUint16(8, true);
  expect(new TextDecoder().decode(data.slice(10, 10 + length))).toContain("'descr': '<u2'");
  expect(new TextDecoder().decode(data.slice(10, 10 + length))).toContain("'shape': (2, 2)");
  expect(Array.from(data.slice(10 + length))).toEqual([1, 0, 0, 1, 255, 255, 7, 0]);
});
it('records the grayscale palette and green outline override without changing source colors', () => {
  const sourceColor = 'FF0000',
    run = {
      cells: [],
      metadata: { channels: [{ name: 'DNA', color: sourceColor }] },
    } as unknown as RunResult;
  const record = provenance(run);
  expect(record).toMatchObject({
    display_palette: 'grayscale',
    segmentation_outline_color: '#00FF00',
  });
  expect(record.metadata.channels[0].color).toBe(sourceColor);
});
it('restricts metadata SQL to a single select', () => {
  expect(validateSelect('SELECT cell_id FROM cells ORDER BY area DESC;')).toBe(
    'SELECT cell_id FROM cells ORDER BY area DESC',
  );
  expect(() => validateSelect('DROP TABLE cells')).toThrow(/SELECT/);
  expect(() => validateSelect('SELECT 1; DROP TABLE cells')).toThrow(/single/);
});
