import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cropObject,
  extractObjects,
  DEFAULT_SETTINGS,
  type ObjectMeasurement,
  type Pixels,
} from '../src/core';
import { runPipeline, type ImageSource } from '../src/pipeline';

const fixture = new URL('./fixtures/idr0076-10501752/', import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, fixture), 'utf8'));
const manifest = json('manifest.json');
const reference = json('expected.json');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const imageBytes = readFileSync(new URL(manifest.files.image.path, fixture));
const labelBytes = readFileSync(new URL(manifest.files.labels.path, fixture));
// DataView makes the checked-in little-endian contract explicit on every host.
const imageView = new DataView(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength);
const labelView = new DataView(labelBytes.buffer, labelBytes.byteOffset, labelBytes.byteLength);
const image = Float64Array.from({ length: imageBytes.length / 8 }, (_, i) =>
  imageView.getFloat64(i * 8, true),
);
const labels = Uint32Array.from({ length: labelBytes.length / 2 }, (_, i) =>
  labelView.getInt16(i * 2, true),
);
const { x, y, width, height } = manifest.region;
const objects = () => extractObjects(labels, [image], width, height, { x, y });
const floatBytes = (values: ArrayLike<number>) => {
  const bytes = new Uint8Array(values.length * 8),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat64(i * 8, values[i], true);
  return bytes;
};

describe('independent IDR0076 / 10501752 native scientific reference', () => {
  it('pins the unchanged real c42 Float64 image and aligned Int16 instance-label ROI', () => {
    expect(imageBytes.length).toBe(width * height * 8);
    expect(labelBytes.length).toBe(width * height * 2);
    expect(hash(imageBytes)).toBe(manifest.files.image.sha256);
    expect(hash(labelBytes)).toBe(manifest.files.labels.sha256);
    expect(manifest.region).toMatchObject({ level: 0, channel: 42, t: 0, z: 0 });
    expect(manifest.projection).toBe('none; source has c,y,x axes and no z or t axis');
    expect(image.some((value) => value !== Math.trunc(value))).toBe(true);
    expect(labels.filter(Boolean).length).toBe(reference.foreground_pixels);
    expect(new Set(labels).size - 1).toBe(reference.object_count);
  });

  it('matches every skimage regionprops/SciPy object, not a second JS implementation', () => {
    const actual = objects();
    expect(actual).toHaveLength(reference.object_count);
    expect(actual.map((o) => o.label)).toEqual(
      reference.objects.map((o: ObjectMeasurement) => o.label),
    );
    for (const [index, expected] of reference.objects.entries()) {
      const object = actual[index];
      for (const key of ['label', 'area', 'x', 'y', 'width', 'height', 'edge'] as const)
        expect(object[key], `label ${expected.label} ${key}`).toEqual(expected[key]);
      expect(object.cx, `label ${expected.label} centroid x`).toBeCloseTo(expected.cx, 11);
      expect(object.cy, `label ${expected.label} centroid y`).toBeCloseTo(expected.cy, 11);
      expect(object.means).toHaveLength(1);
      expect(object.means[0], `label ${expected.label} native c42 mean`).toBeCloseTo(
        expected.means[0],
        11,
      );
    }
    expect(actual.filter((o) => o.edge).map((o) => o.label)).toEqual(reference.edge_labels);
    expect(actual.filter((o) => !o.edge).map((o) => o.label)).toEqual(reference.interior_labels);
    expect(actual.reduce((sum, o) => sum + o.area, 0)).toBe(reference.foreground_pixels);
  });

  it('keeps measurements in global image coordinates and preserves caller inputs', () => {
    const beforeImage = hash(floatBytes(image)),
      beforeLabels = Array.from(labels);
    const shifted = extractObjects(labels, [image], width, height, { x: x + 1000, y: y + 2000 });
    objects().forEach((object, i) => {
      expect({ ...shifted[i], cx: 0, cy: 0 }).toEqual({
        ...object,
        cx: 0,
        cy: 0,
        x: object.x + 1000,
        y: object.y + 2000,
      });
      expect(shifted[i].cx).toBeCloseTo(object.cx + 1000, 10);
      expect(shifted[i].cy).toBeCloseTo(object.cy + 2000, 10);
    });
    expect(hash(floatBytes(image))).toBe(beforeImage);
    expect(Array.from(labels)).toEqual(beforeLabels);
  });

  it('runs the existing-label pipeline on real native pixels without inference or SQL', async () => {
    // Explicit offline ROI adapter, not a claim of live/source metadata access.
    // Its local coordinates start at 0; translation restores original pixels.
    const adapter = (pixels: Pixels, channelCount: number): ImageSource => ({
      metadata: {
        version: '0.4',
        axes: [{ name: 'c' }, { name: 'y' }, { name: 'x' }],
        levels: [{ path: '0', scale: [1, 1, 1], translation: [0, y, x] }],
        channels: [],
        labels: ['0'],
      },
      stats: { requests: 0, bytes: 0, cacheHits: 0, objects: [] },
      async alignment() {
        return {
          axes: ['c', 'y', 'x'],
          shape: [channelCount, height, width],
          scale: [1, 1, 1],
          translation: [0, y, x],
        };
      },
      async readRegion(_level, request) {
        expect(request.z).toBe(0);
        expect(request.t).toBe(0);
        expect(request.channel).toBe(channelCount === 1 ? 0 : 42);
        const out = new (pixels.constructor as { new (length: number): Pixels })(
          request.width * request.height,
        );
        for (let row = 0; row < request.height; row++)
          out.set(
            pixels.subarray(
              (request.y + row) * width + request.x,
              (request.y + row) * width + request.x + request.width,
            ),
            row * request.width,
          );
        return out;
      },
    });
    const run = await runPipeline(
      {
        ...DEFAULT_SETTINGS,
        source: 'https://example.invalid/checked-in-idr0076-roi/',
        reader: 'browser',
        segmentation: 'labels',
        labelPath: '0',
        level: 0,
        t: 0,
        z: 0,
        channels: [42],
        segmentChannel: 42,
        tile: 128,
        count: 1,
        target: 100,
        cropSize: 32,
        minArea: 1,
        maxArea: 10000,
        excludeEdges: true,
        padding: 8,
        seed: 'scientific-fixture',
      },
      {
        signal: new AbortController().signal,
        source: adapter(image, 50),
        labels: adapter(labels, 1),
      },
    );
    expect(run.cells.map((cell) => cell.label).sort((a, b) => a - b)).toEqual(
      reference.interior_labels,
    );
    for (const cell of run.cells) {
      const pinned = reference.objects.find(
        (object: ObjectMeasurement) => object.label === cell.label,
      );
      expect(cell.area).toBe(pinned.area);
      expect(cell.x).toBe(pinned.x - x);
      expect(cell.y).toBe(pinned.y - y);
      expect(cell.physical_x).toBeCloseTo(pinned.cx, 11);
      expect(cell.physical_y).toBeCloseTo(pinned.cy, 11);
      expect(cell.means[0]).toBeCloseTo(pinned.means[0], 11);
      const crop = reference.crops.find(
        (entry: { label: number; padding: number; minimum_size: number }) =>
          entry.label === cell.label && entry.padding === 8 && entry.minimum_size === 32,
      );
      expect(cell.crop).toMatchObject({
        ...crop.region,
        x: crop.region.x - x,
        y: crop.region.y - y,
      });
      expect(hash(floatBytes(cell.crop.channels[0]))).toBe(crop.image_sha256);
      const targetMask = Uint8Array.from(cell.mask, (label) => Number(label === cell.label));
      expect(hash(targetMask)).toBe(crop.mask_sha256);
      expect(targetMask.reduce((sum, value) => sum + value, 0)).toBe(pinned.area);
    }
  });

  it('preserves native crop bytes, bbox-centered padding, clipped edges and target masks', () => {
    const byLabel = new Map(objects().map((object) => [object.label, object]));
    for (const expected of reference.crops) {
      const object = byLabel.get(expected.label)!;
      const crop = cropObject(
        [image],
        width,
        height,
        object,
        { x, y },
        expected.padding,
        expected.minimum_size,
      );
      expect({ x: crop.x, y: crop.y, width: crop.width, height: crop.height }).toEqual(
        expected.region,
      );
      expect(crop.channels[0]).toBeInstanceOf(Float64Array);
      expect(hash(floatBytes(crop.channels[0])), `label ${object.label} crop`).toBe(
        expected.image_sha256,
      );
      // Exercise the same public crop function with labels; this is a binary
      // target mask, never all nonzero neighbors in the crop rectangle.
      const labelCrop = cropObject(
        [labels],
        width,
        height,
        object,
        { x, y },
        expected.padding,
        expected.minimum_size,
      );
      const mask = Uint8Array.from(labelCrop.channels[0], (label) =>
        Number(label === object.label),
      );
      expect(mask.reduce((sum, v) => sum + v, 0)).toBe(object.area);
      expect(hash(mask), `label ${object.label} isolated mask`).toBe(expected.mask_sha256);
      const isolated = Float64Array.from(crop.channels[0], (value, i) => (mask[i] ? value : 0));
      expect(hash(floatBytes(isolated))).toBe(expected.masked_image_sha256);
      if (!expected.clipped) {
        const side = Math.max(
          expected.minimum_size,
          object.width + 2 * expected.padding,
          object.height + 2 * expected.padding,
        );
        expect(crop.width).toBe(side);
        expect(crop.height).toBe(side);
        // An odd difference between square side and bbox side rounds the
        // center toward top/left by half a pixel; no resampling is allowed.
        expect(
          Math.abs(crop.x + crop.width / 2 - (object.x + object.width / 2)),
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(crop.y + crop.height / 2 - (object.y + object.height / 2)),
        ).toBeLessThanOrEqual(0.5);
        expect(object.x - crop.x).toBeGreaterThanOrEqual(expected.padding);
        expect(object.y - crop.y).toBeGreaterThanOrEqual(expected.padding);
      }
    }
    expect(reference.crops.some((crop: { clipped: boolean }) => crop.clipped)).toBe(true);
    expect(reference.crops.some((crop: { clipped: boolean }) => !crop.clipped)).toBe(true);
  });
});
