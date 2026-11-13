import { describe, it, expect } from 'vitest';
import { arrayInfo, planChunks, chunkView } from '../src/sources/chunks';
const v2 = {
  zarr_format: 2,
  shape: [2, 3, 4, 8, 8],
  chunks: [1, 1, 1, 4, 4],
  dtype: '<u2',
  compressor: null,
  fill_value: 0,
  filters: null,
  order: 'C',
  dimension_separator: '/',
};
const axes = ['t', 'c', 'z', 'y', 'x'];
const request = { t: 1, channel: 2, z: 3, x: 3, y: 3, width: 2, height: 2 };
describe('bounded original-chunk DuckDB views', () => {
  it('plans only the four intersecting chunks of the selected T/C/Z plane', () => {
    const info = arrayInfo(v2),
      plans = planChunks(info, axes, request);
    expect(plans.map((p) => p.key)).toEqual(['1/2/3/0/0', '1/2/3/0/1', '1/2/3/1/0', '1/2/3/1/1']);
    expect(plans[0].origin).toEqual([1, 2, 3, 0, 0]);
  });
  it('creates a complete one-chunk codec wrapper, not a sparse original-size scan', () => {
    const info = arrayInfo(v2),
      view = chunkView(info, axes);
    expect(view.shape).toEqual(v2.chunks);
    expect(view.chunk_grid.configuration.chunk_shape).toEqual(v2.chunks);
    expect(view.dimension_names).toEqual(axes);
    expect(view.codecs).toEqual([{ name: 'bytes', configuration: { endian: 'little' } }]);
    expect(v2.shape).toEqual([2, 3, 4, 8, 8]);
  });
  it('rejects chunks spanning extra Z/time planes before data fetches', () => {
    expect(() => planChunks(arrayInfo({ ...v2, chunks: [1, 1, 2, 4, 4] }), axes, request)).toThrow(
      /z-chunk/,
    );
    expect(() => planChunks(arrayInfo({ ...v2, chunks: [2, 1, 1, 4, 4] }), axes, request)).toThrow(
      /t-chunk/,
    );
  });
  it('rejects invalid regions and oversized decoded chunks', () => {
    expect(() => planChunks(arrayInfo(v2), axes, { ...request, x: 8 })).toThrow(/bounds/);
    expect(() =>
      planChunks(
        arrayInfo({ ...v2, shape: [2, 3, 4, 8192, 8192], chunks: [1, 1, 1, 8192, 8192] }),
        axes,
        request,
      ),
    ).toThrow(/budget/);
  });
  it('preserves original v3 codec pipeline and dtype when wrapping a chunk', () => {
    const metadata = {
      zarr_format: 3,
      node_type: 'array',
      shape: [5, 100, 100],
      data_type: 'float32',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, 32, 32] } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      fill_value: 0,
      codecs: [
        { name: 'bytes', configuration: { endian: 'little' } },
        {
          name: 'blosc',
          configuration: { cname: 'lz4', clevel: 5, shuffle: 'shuffle', typesize: 4, blocksize: 0 },
        },
      ],
      attributes: {},
    };
    const info = arrayInfo(metadata),
      view = chunkView(info, ['c', 'y', 'x']);
    expect(view.codecs).toEqual(metadata.codecs);
    expect(view.data_type).toBe('float32');
    expect(view.shape).toEqual([1, 32, 32]);
    expect(() => arrayInfo({ ...metadata, data_type: 'constructor' })).toThrow(/dtype/);
    expect(() => arrayInfo({ ...metadata, storage_transformers: [{ name: 'unknown' }] })).toThrow(
      /transformers/,
    );
    expect(
      planChunks(info, ['c', 'y', 'x'], {
        channel: 4,
        z: 0,
        t: 0,
        x: 40,
        y: 40,
        width: 2,
        height: 2,
      })[0].key,
    ).toBe('c/4/1/1');
  });
});
