import { zip, strToU8 } from 'fflate';
import type { Pixels } from './core';
import { cellRow, type RunResult, type Cell } from './pipeline';
export function validateSelect(sql: string): string {
  const s = sql.trim().replace(/;\s*$/, '');
  if (!/^SELECT\b/i.test(s)) throw Error('Use a SELECT query against cells');
  if (s.includes(';')) throw Error('Only a single SELECT statement is allowed');
  return s;
}
/** NumPy v1: little-endian native values, row-major (y, x), no display normalization. */
export function npy(pixels: Pixels, width: number, height: number): Uint8Array {
  if (pixels.length !== width * height) throw Error('NumPy plane shape mismatch');
  const dtype =
    pixels instanceof Uint8Array
      ? '|u1'
      : pixels instanceof Uint16Array
        ? '<u2'
        : pixels instanceof Int16Array
          ? '<i2'
          : pixels instanceof Uint32Array
            ? '<u4'
            : pixels instanceof Int32Array
              ? '<i4'
              : pixels instanceof Float32Array
                ? '<f4'
                : '<f8';
  let header = `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${height}, ${width}), }`;
  header += ' '.repeat((64 - ((10 + header.length + 1) % 64)) % 64) + '\n';
  const result = new Uint8Array(10 + header.length + pixels.byteLength);
  result.set([147, 78, 85, 77, 80, 89, 1, 0]);
  new DataView(result.buffer).setUint16(8, header.length, true);
  result.set(strToU8(header), 10);
  const native = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    little = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1,
    offset = 10 + header.length,
    b = pixels.BYTES_PER_ELEMENT;
  if (little || b === 1) result.set(native, offset);
  else
    for (let i = 0; i < native.length; i += b)
      for (let j = 0; j < b; j++) result[offset + i + j] = native[i + b - j - 1];
  return result;
}
export function download(
  bytes: Uint8Array | Blob,
  name: string,
  type = 'application/octet-stream',
) {
  const blob =
      bytes instanceof Blob ? bytes : new Blob([bytes.slice().buffer as ArrayBuffer], { type }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function cropArchive(
  result: RunResult,
  cells: Cell[] = result.cells,
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const cell of cells) {
    const prefix = cell.cell_id;
    cell.crop.channels.forEach(
      (p, i) =>
        (files[`${prefix}/channel_${cell.channels[i]}.npy`] = npy(
          p,
          cell.crop.width,
          cell.crop.height,
        )),
    );
    files[`${prefix}/labels.npy`] = npy(cell.mask, cell.crop.width, cell.crop.height);
  }
  files['manifest.json'] = strToU8(
    JSON.stringify(
      {
        ...provenance(result),
        cells: cells.map(cellRow),
        note: 'Native (y, x) NumPy arrays, channels in source dtype; labels include neighbors and preserve instance ids. PNG previews are display-normalized, not raw measurements.',
      },
      null,
      2,
    ),
  );
  return new Promise((resolve, reject) =>
    zip(files, { level: 1 }, (error, data) => (error ? reject(error) : resolve(data))),
  );
}
export function provenance(result: RunResult) {
  const { cells, ...run } = result;
  return {
    ...run,
    cell_count: cells.length,
    software: 'musivarium 0.1.0',
    normalization: '1st–99.5th percentile per crop per channel for display only',
    display_palette: 'grayscale',
    segmentation_outline_color: '#00FF00',
    geometry:
      'One explicit z plane, not a projection; area in selected-level pixels; coordinates use pixel-index centers, physical = translation + scale × index',
  };
}
