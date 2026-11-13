import { expect, it } from 'vitest';
import { associationKey } from '../src/voice/context';
import type { VoiceContext } from '../src/voice/types';
const labels: VoiceContext = {
  imageId: 'idr-image',
  selectedCellIds: ['cell-1'],
  labelSource: 'nuclei-A',
  segmentationModel: 'source-labels',
  segmentationVersion: 'source-instance-labels',
  plane: { level: 0, t: 0, z: 0, channels: [42], segmentChannel: 42 },
  samplingSeed: 'first',
};
const key = (value: VoiceContext) => associationKey(value, 'cell-1');
it('association distinguishes label stores, segmentation versions, models and planes', () => {
  for (const different of [
    { ...labels, labelSource: 'nuclei-B' },
    { ...labels, imageId: 'other-image' },
    { ...labels, segmentationVersion: 'different-version' },
    { ...labels, segmentationModel: 'different-model' },
    { ...labels, plane: { ...labels.plane!, z: 1 } },
  ])
    expect(key(different)).not.toBe(key(labels));
  expect(associationKey(labels, 'cell-2')).not.toBe(key(labels));
});
it('source-label associations persist across seeds, display channels and crop/filter changes', () => {
  expect(
    key({
      ...labels,
      samplingSeed: 'later',
      plane: { ...labels.plane!, channels: [1], segmentChannel: 1 },
      settingsJson: JSON.stringify({
        seed: 'later',
        cropSize: 64,
        modelThreshold: 0.7,
        minArea: 5,
      }),
    }),
  ).toBe(key(labels));
});
it('computed segmentations distinguish thresholds, sampling window sizes and segmentation channels', () => {
  const settings = {
    segmentation: 'model',
    tile: 256,
    modelThreshold: 0.5,
    seed: 'first',
    target: 100,
  };
  const context = {
    ...labels,
    labelSource: '',
    segmentationModel: 'stardist',
    settingsJson: JSON.stringify(settings),
  };
  for (const change of [{ tile: 512 }, { modelThreshold: 0.7 }])
    expect(key({ ...context, settingsJson: JSON.stringify({ ...settings, ...change }) })).not.toBe(
      key(context),
    );
  expect(key({ ...context, plane: { ...context.plane!, segmentChannel: 1 } })).not.toBe(
    key(context),
  );
  expect(
    key({
      ...context,
      samplingSeed: 'later',
      settingsJson: JSON.stringify({
        ...settings,
        seed: 'later',
        target: 3,
        minArea: 99,
        cropSize: 64,
      }),
    }),
  ).toBe(key(context));
  const classical = {
    ...context,
    settingsJson: JSON.stringify({ segmentation: 'classical', tile: 256, classicalThreshold: '' }),
  };
  expect(
    key({
      ...classical,
      settingsJson: JSON.stringify({
        segmentation: 'classical',
        tile: 256,
        classicalThreshold: '123',
      }),
    }),
  ).not.toBe(key(classical));
});
