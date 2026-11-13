import type { Cell } from '../pipeline';
import type { VoiceContext } from './types';

/** Copy only metadata; never retain microscopy arrays in a draft or IndexedDB. */
export function contextForCell(cell: Cell): VoiceContext {
  return {
    imageId: cell.source,
    selectedCellIds: [cell.cell_id],
    region: { x: cell.x, y: cell.y, width: cell.width, height: cell.height, level: cell.level },
    plane: {
      level: cell.level,
      t: cell.t,
      z: cell.z,
      channels: [...cell.channels],
      segmentChannel: cell.segment_channel,
    },
    segmentationModel: cell.model_id,
    segmentationVersion: cell.segmentation_version,
    labelSource: cell.label_source,
    samplingSeed: cell.seed,
    settingsJson: cell.settings_json,
  };
}

/** One scientific identity for both tile badges and cell-scoped note listings.
 * Sampling seeds, display channels and crop/filter settings do not rename a
 * source-label object. Computed masks additionally depend on the window,
 * threshold and segmentation channel; their numeric labels are not universal.
 */
export function associationKey(context: VoiceContext, cellId: string): string {
  const plane = context.plane;
  let computed: unknown = null;
  if (!context.labelSource) {
    try {
      const parsed: unknown = JSON.parse(context.settingsJson ?? '{}');
      const settings =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      computed = [
        plane?.segmentChannel ?? null,
        settings.segmentation ?? null,
        settings.tile ?? null,
        settings.segmentation === 'model'
          ? (settings.modelThreshold ?? null)
          : settings.segmentation === 'classical'
            ? (settings.classicalThreshold ?? null)
            : null,
      ];
    } catch {
      // Unknown settings must not be conflated with a known computed mask.
      computed = ['unreadable-settings', context.settingsJson];
    }
  }
  return JSON.stringify([
    context.imageId ?? null,
    cellId,
    context.labelSource ?? null,
    context.segmentationModel ?? null,
    context.segmentationVersion ?? null,
    plane?.level ?? null,
    plane?.t ?? null,
    plane?.z ?? null,
    computed,
  ]);
}
