import { describe, expect, it } from 'vitest';
import { createNote, snapshotContext, validateNote, exportNotes } from '../src/voice/notes-store';
import type { VoiceContext } from '../src/voice/types';

const context: VoiceContext = {
  imageId: 'https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/',
  selectedCellIds: ['selected-cell'],
  region: { x: 13, y: 20, width: 32, height: 48, level: 0 },
  plane: { level: 0, t: 0, z: 0, channels: [42], segmentChannel: 42 },
  samplingSeed: 'sample-seed',
  segmentationModel: 'idr-labels',
};

describe('local scientific notes', () => {
  it('snapshots context and never follows later selection or plane mutations', () => {
    const current = structuredClone(context);
    const snapshot = snapshotContext(current);
    current.selectedCellIds.push('another-cell');
    current.plane!.channels[0] = 0;
    current.region!.x = 999;
    expect(snapshot.selectedCellIds).toEqual(['selected-cell']);
    expect(snapshot.plane!.channels).toEqual([42]);
    expect(snapshot.region!.x).toBe(13);
    expect(snapshot.contextCapturedAt).toMatch(/^\d{4}-/);
  });
  it('records human manual entries honestly, separately from local Whisper', () => {
    const manual = createNote(snapshotContext(context), '  nucleus and cytoplasm  ');
    expect(manual.source).toBe('manual');
    expect(manual.modelId).toBe('manual');
    expect(manual.text).toBe('nucleus and cytoplasm');
    const spoken = createNote(snapshotContext(context), 'edited Zarr', {
      text: 'raw czar',
      modelId: 'onnx-community/whisper-tiny.en',
      modelRevision: 'immutable-revision',
    });
    expect(spoken.source).toBe('local-whisper');
    expect(spoken.rawTranscript).toBe('raw czar');
    expect(spoken.modelRevision).toBe('immutable-revision');
    expect(validateNote(spoken)).toEqual(spoken);
  });
  it('exports Unicode text, context, timestamps and original transcript without loss; no audio', () => {
    const note = createNote(
      snapshotContext(context),
      'Nucleus: fluorescence.\nCytoplasm: α-tubulin.',
    );
    const payload = JSON.parse(exportNotes([note]));
    expect(payload.schemaVersion).toBe(1);
    expect(payload.notes).toEqual([note]);
    expect(validateNote(payload.notes[0])).toEqual(note);
    expect(Object.keys(payload.notes[0])).not.toContain('audio');
  });
  it('rejects unsupported versions, empty/oversized text, bad timestamps, corrupt context and false ASR provenance', () => {
    const note = createNote(snapshotContext(context), 'note');
    for (const bad of [
      { ...note, schemaVersion: 2 },
      { ...note, text: ' ' },
      { ...note, text: 'x'.repeat(20001) },
      { ...note, createdAt: 'not a date' },
      { ...note, updatedAt: '2020-01-01T00:00:00Z' },
      { ...note, selectedCellIds: 'cell' },
      { ...note, region: { ...note.region, width: -1 } },
      { ...note, plane: { ...note.plane, z: -1 } },
      { ...note, source: 'remote-asr' },
      { ...note, source: 'manual', modelId: 'whisper' },
      { ...note, source: 'local-whisper', modelId: '' },
    ])
      expect(() => validateNote(bad)).toThrow();
    expect(() => createNote(snapshotContext(context), '')).toThrow(/text/i);
  });
});
