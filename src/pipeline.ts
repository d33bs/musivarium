import {
  cropObject,
  extractObjects,
  sampleWindows,
  validateSettings,
  random,
  type Settings,
  type Pixels,
  type ObjectMeasurement,
  type Crop,
  type Region,
} from './core';
import {
  BrowserSource,
  validateLabelAlignment,
  type Alignment,
  type NgffMetadata,
  type NetworkStats,
  type PlaneRequest,
} from './sources/browser';
import type { ImageSource } from './sources/types';
import { openImageSource } from './sources/factory';
import { ReadSession, type NetworkProgress } from './sources/read-session';
export type { ImageSource } from './sources/types';
export interface Cell extends ObjectMeasurement {
  cell_id: string;
  source: string;
  reader: string;
  segmentation: string;
  label_source: string;
  level: number;
  t: number;
  z: number;
  channels: number[];
  segment_channel: number;
  seed: string;
  tile_index: number;
  crop: Crop;
  mask: Uint32Array;
  physical_x: number;
  physical_y: number;
  physical_z: number;
  unit: string;
  scale_x: number;
  scale_y: number;
  scale_z: number;
  model_id: string;
  region_x: number;
  region_y: number;
  region_width: number;
  region_height: number;
  settings_json: string;
  segmentation_version: string;
}
export interface TileResult extends Region {
  index: number;
  objects: number;
  accepted: number;
}
export interface RunResult {
  settings: Settings;
  metadata: NgffMetadata;
  alignment: Alignment;
  cells: Cell[];
  tiles: TileResult[];
  stats: NetworkStats;
  timings: Record<string, number>;
  warnings: string[];
  created: string;
  model_id: string;
}
export interface Progress {
  stage: string;
  completed: number;
  total: number;
  cells: number;
}
export async function runPipeline(
  settings: Settings,
  options: {
    signal: AbortSignal;
    source?: ImageSource;
    labels?: ImageSource;
    onProgress?: (p: Progress) => void;
    onNetwork?: (p: NetworkProgress) => void;
    onBatch?: (p: { cells: Cell[]; metadata: NgffMetadata; alignment: Alignment }) => void;
  },
): Promise<RunResult> {
  const session = new ReadSession(options.signal, options.onNetwork);
  try {
    const s = validateSettings(settings),
      signal = session.signal,
      start = performance.now();
    signal.throwIfAborted();
    let total = s.count;
    const notify = (stage: string, completed = 0, cells = 0) =>
      options.onProgress?.({ stage, completed, total, cells });
    notify('Reading metadata');
    const sourceTask = options.source
      ? Promise.resolve(options.source)
      : openImageSource(s.source, s.reader, signal, session);
    if (s.reader === 'duckdb-zarr') await sourceTask;
    let labelSource = options.labels,
      labelMetadataMs = 0;
    const labelStarted = performance.now();
    const labelReady = (async () => {
      if (s.segmentation !== 'labels') return undefined;
      let labels = options.labels;
      if (!labels) {
        const path = s.labelPath || (await sourceTask).metadata.labels[0];
        if (!path)
          throw Error(
            'No existing labels found. Choose a label group or another segmentation backend.',
          );
        labels = await BrowserSource.open(
          /^https?:/.test(path)
            ? path
            : new URL(`labels/${path.replace(/^labels\//, '')}`, s.source.replace(/\/*$/, '/'))
                .href,
          signal,
          session,
        );
      }
      const alignment = await labels.alignment(s.level);
      labelMetadataMs = performance.now() - labelStarted;
      return { source: labels, alignment };
    })().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const source = await sourceTask,
      alignment = await source.alignment(s.level),
      axes = alignment.axes,
      width = alignment.shape[axes.indexOf('x')],
      height = alignment.shape[axes.indexOf('y')];
    const channels = axes.includes('c') ? alignment.shape[axes.indexOf('c')] : 1;
    if (s.channels.some((c) => c >= channels))
      throw Error(`Channel out of bounds: image has ${channels} channels`);
    for (const name of ['t', 'z'] as const) {
      const length = axes.includes(name) ? alignment.shape[axes.indexOf(name)] : 1;
      if (s[name] >= length) throw Error(`${name} index out of bounds (0–${length - 1})`);
    }
    const available = Math.ceil(width / s.tile) * Math.ceil(height / s.tile),
      windows = sampleWindows(width, height, s.tile, Math.min(s.count, available), s.seed),
      cells: Cell[] = [],
      tiles: TileResult[] = [],
      warnings: string[] = [];
    const seen = new Set<string>();
    let imageHash = 2166136261;
    for (const char of s.source) imageHash = Math.imul(imageHash ^ char.charCodeAt(0), 16777619);
    const namespace = (imageHash >>> 0).toString(16);
    let modelId = 'none';
    total = windows.length;
    if (s.segmentation === 'classical')
      warnings.push(
        'Classical threshold + connected components is a baseline; touching nuclei may merge. These are segmented objects, not validated whole cells.',
      );
    if (s.level > 0)
      warnings.push(
        'Coarse-resolution segmentation is exploratory. Areas and coordinates are in the selected level, not level-0 pixels.',
      );
    const timings: Record<string, number> = {
      metadata: performance.now() - start,
      reading: 0,
      segmentation: 0,
      measurement: 0,
      total: 0,
    };
    let retainedBytes = 0;
    for (let index = 0; index < windows.length; index++) {
      signal.throwIfAborted();
      const window = windows[index];
      notify(`Reading tile ${index + 1} / ${windows.length}`, index, cells.length);
      let mark = performance.now();
      const imagePixels = Promise.all(
        s.channels.map((channel) =>
          source.readRegion(s.level, { ...window, z: s.z, t: s.t, channel }),
        ),
      );
      const labelPixels = (async () => {
        if (s.segmentation !== 'labels') return undefined;
        const prepared = await labelReady;
        if ('error' in prepared) throw prepared.error;
        const data = prepared.value!;
        labelSource = data.source;
        validateLabelAlignment(alignment, data.alignment);
        const begun = performance.now();
        try {
          return await labelSource.readRegion(s.level, { ...window, z: s.z, t: s.t, channel: 0 });
        } finally {
          timings.label_reading = (timings.label_reading ?? 0) + performance.now() - begun;
        }
      })();
      const [planes, raw] = await Promise.all([imagePixels, labelPixels]);
      timings.reading += performance.now() - mark;
      let labels: Uint32Array;
      mark = performance.now();
      notify(`Segmenting tile ${index + 1} / ${windows.length}`, index, cells.length);
      if (s.segmentation === 'labels') {
        if (!raw) throw Error('Label raster unavailable');
        if (raw.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 4294967295))
          throw Error('Label values must be nonnegative uint32 instance identifiers');
        labels = Uint32Array.from(raw);
      } else if (s.segmentation === 'classical') {
        const { segmentClassical } = await import('./segmentation/classical');
        labels = segmentClassical(
          Float32Array.from(planes[s.channels.indexOf(s.segmentChannel)]),
          window.width,
          window.height,
          {
            minArea: 1,
            ...(s.classicalThreshold !== '' ? { threshold: Number(s.classicalThreshold) } : {}),
          },
        );
      } else {
        const { segmentModel, MODEL_ID } = await import('./segmentation/model');
        const prediction = await segmentModel(
          Float32Array.from(planes[s.channels.indexOf(s.segmentChannel)]),
          window.width,
          window.height,
          { signal, threshold: s.modelThreshold },
        );
        labels = prediction;
        modelId = MODEL_ID;
      }
      signal.throwIfAborted();
      if (s.segmentation !== 'labels') timings.segmentation += performance.now() - mark;
      mark = performance.now();
      const objects = extractObjects(labels, planes, window.width, window.height, window),
        accepted = objects.filter(
          (o) => o.area >= s.minArea && o.area <= s.maxArea && (!s.excludeEdges || !o.edge),
        );
      const rng = random(`${s.seed}/objects/${index}`);
      for (let j = accepted.length - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        [accepted[j], accepted[k]] = [accepted[k], accepted[j]];
      }
      const batch: Cell[] = [];
      for (const object of accepted) {
        if (cells.length >= s.target) break;
        const identity =
          s.segmentation === 'labels'
            ? String(object.label)
            : `${window.x}-${window.y}-${object.label}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (cells.length >= 1500) {
          warnings.push(
            'Stopped retaining crops at the 1,500-object safety limit; reduce tile count or increase minimum area.',
          );
          break;
        }
        const crop = cropObject(
            planes,
            window.width,
            window.height,
            object,
            window,
            s.padding,
            s.cropSize,
          ),
          cropBytes =
            crop.channels.reduce((sum, p) => sum + p.byteLength, 0) + crop.width * crop.height * 4;
        if (retainedBytes + cropBytes > 48 * 1024 * 1024)
          throw Error(
            'Crop budget exceeded (48 MiB). Reduce tile count, padding, or maximum area.',
          );
        retainedBytes += cropBytes;
        const mask = new Uint32Array(crop.width * crop.height);
        for (let y = 0; y < crop.height; y++)
          for (let x = 0; x < crop.width; x++)
            mask[y * crop.width + x] =
              labels[(crop.y - window.y + y) * window.width + crop.x - window.x + x];
        const ax = (name: string) => axes.indexOf(name),
          scale = (name: string) => (ax(name) < 0 ? 1 : alignment.scale[ax(name)]),
          position = (name: string, v: number) =>
            ax(name) < 0 ? 0 : alignment.translation[ax(name)] + scale(name) * v;
        cells.push({
          ...object,
          cell_id: `${namespace}-${s.segmentation}-L${s.level}-T${s.t}-Z${s.z}-I${identity}`,
          source: s.source,
          reader: s.reader,
          segmentation: s.segmentation,
          label_source:
            s.segmentation === 'labels'
              ? s.labelPath || source.metadata.labels[0] || 'provided'
              : '',
          level: s.level,
          t: s.t,
          z: s.z,
          channels: [...s.channels],
          segment_channel: s.segmentChannel,
          seed: s.seed,
          tile_index: index,
          crop,
          mask,
          physical_x: position('x', object.cx),
          physical_y: position('y', object.cy),
          physical_z: position('z', s.z),
          unit: source.metadata.axes.find((a) => a.name === 'x')?.unit ?? 'pixel',
          scale_x: scale('x'),
          scale_y: scale('y'),
          scale_z: scale('z'),
          model_id: modelId,
          region_x: window.x,
          region_y: window.y,
          region_width: window.width,
          region_height: window.height,
          settings_json: JSON.stringify(s),
          segmentation_version:
            s.segmentation === 'model'
              ? modelId
              : s.segmentation === 'classical'
                ? 'otsu-8connected-v1'
                : 'source-instance-labels',
        });
        batch.push(cells[cells.length - 1]);
      }
      timings.measurement += performance.now() - mark;
      tiles.push({ ...window, index, objects: objects.length, accepted: accepted.length });
      notify(`Completed tile ${index + 1} / ${windows.length}`, index + 1, cells.length);
      if (batch.length) options.onBatch?.({ cells: batch, metadata: source.metadata, alignment });
      if (source.stats.bytes + (labelSource?.stats.bytes ?? 0) > 96 * 1024 * 1024)
        throw Error('Combined image + label network budget exceeded (96 MiB).');
      if (cells.length >= s.target) break;
      // Yield between tiles even in a non-worker reference invocation.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (labelSource) {
      source.stats.requests += labelSource.stats.requests;
      source.stats.bytes += labelSource.stats.bytes;
      source.stats.cacheHits += labelSource.stats.cacheHits;
      source.stats.fetch_ms = (source.stats.fetch_ms ?? 0) + (labelSource.stats.fetch_ms ?? 0);
      source.stats.decoded_bytes =
        (source.stats.decoded_bytes ?? 0) + (labelSource.stats.decoded_bytes ?? 0);
      source.stats.objects.push(...labelSource.stats.objects);
    }
    if (cells.length < s.target)
      warnings.push(
        `Found ${cells.length} of ${s.target} requested objects within ${windows.length} sampled tiles; try another seed or increase the tile budget.`,
      );
    timings.decoding_copy =
      (source.stats.decode_copy_ms ?? 0) + (labelSource?.stats.decode_copy_ms ?? 0);
    timings.source_fetch_cumulative = source.stats.fetch_ms ?? 0;
    timings.label_metadata = labelMetadataMs;
    timings.max_network_requests = session.snapshot().maxActive;
    timings.peak_decoded_bytes = session.snapshot().maxDecodedBytes;
    timings.total = performance.now() - start;
    timings.crop_bytes = retainedBytes;
    return {
      settings: s,
      metadata: source.metadata,
      alignment,
      cells,
      tiles,
      stats: source.stats,
      timings,
      warnings: [...new Set(warnings)],
      created: new Date().toISOString(),
      model_id: modelId,
    };
  } catch (error) {
    session.cancel(error);
    throw error;
  }
}
export function cellRow(cell: Cell): Record<string, string | number | boolean> {
  const { crop, mask, means, channels, ...row } = cell;
  const result: Record<string, string | number | boolean> = {
    ...row,
    sample_id: cell.source.includes('/idr0076A/10501752.zarr')
      ? 'idr0076-10501752'
      : cell.source.includes('/idr0033A/BR00109990_C2.zarr/0')
        ? 'idr0033-BR00109990-C2-0'
        : cell.source,
    image_url: cell.source,
    object_id: cell.label,
    centroid_x: cell.cx,
    centroid_y: cell.cy,
    bbox_x: cell.x,
    bbox_y: cell.y,
    bbox_width: cell.width,
    bbox_height: cell.height,
    area_pixels: cell.area,
    segmentation_engine: cell.segmentation,
    channels: channels.join(','),
    crop_x: crop.x,
    crop_y: crop.y,
    crop_width: crop.width,
    crop_height: crop.height,
  };
  for (let i = 0; i < means.length; i++) result[`channel_${channels[i]}_mean`] = means[i];
  return result;
}
