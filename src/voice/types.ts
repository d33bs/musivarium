export interface VoiceContext {
  datasetId?: string;
  /** Exact source image-group URL; not the temporary mosaic position. */
  imageId?: string;
  selectedCellIds: string[];
  region?: { x: number; y: number; width: number; height: number; level?: number };
  plane?: { level: number; t: number; z: number; channels: number[]; segmentChannel: number };
  segmentationModel?: string;
  segmentationVersion?: string;
  labelSource?: string;
  samplingSeed?: string;
  settingsJson?: string;
  contextCapturedAt?: string;
}

export interface VoiceNote extends VoiceContext {
  id: string;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  text: string;
  rawTranscript?: string;
  /** Manual input must not be misrepresented as model output. */
  source: 'local-whisper' | 'manual';
  modelId: string;
  modelRevision?: string;
}

export interface Transcript {
  text: string;
  modelId: string;
  modelRevision: string;
}
