import type { Transcript, VoiceContext, VoiceNote } from './types';

export const MAX_NOTE_LENGTH = 20000;
const DB_VERSION = 1;
const STORE = 'notes';

export function snapshotContext(context: VoiceContext): VoiceContext {
  return { ...structuredClone(context), contextCapturedAt: new Date().toISOString() };
}

export function createNote(
  context: VoiceContext,
  text: string,
  transcript?: Transcript,
): VoiceNote {
  const timestamp = new Date().toISOString();
  return validateNote({
    ...structuredClone(context),
    id: crypto.randomUUID(),
    schemaVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    text: text.trim(),
    source: transcript ? 'local-whisper' : 'manual',
    modelId: transcript?.modelId ?? 'manual',
    ...(transcript
      ? { rawTranscript: transcript.text, modelRevision: transcript.modelRevision }
      : {}),
  });
}

/** Validate persisted/exported v1 data; future versions require an explicit migration. */
export function validateNote(value: unknown): VoiceNote {
  if (!value || typeof value !== 'object') throw Error('Invalid note record.');
  const n = value as VoiceNote;
  const validTime = (s: unknown): s is string =>
    typeof s === 'string' && Number.isFinite(Date.parse(s));
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const index = (v: unknown) => finite(v) && Number.isSafeInteger(v) && (v as number) >= 0;
  if (n.schemaVersion !== 1)
    throw Error('Unsupported note schema. Export notes before upgrading this browser.');
  if (
    typeof n.id !== 'string' ||
    !n.id ||
    !validTime(n.createdAt) ||
    !validTime(n.updatedAt) ||
    Date.parse(n.updatedAt) < Date.parse(n.createdAt)
  )
    throw Error('Invalid note identity or timestamps.');
  if (typeof n.text !== 'string' || !n.text.trim() || n.text.length > MAX_NOTE_LENGTH)
    throw Error(`Note text must contain 1–${MAX_NOTE_LENGTH} characters.`);
  if (
    !Array.isArray(n.selectedCellIds) ||
    n.selectedCellIds.some((id) => typeof id !== 'string' || !id)
  )
    throw Error('Invalid note cell context.');
  for (const key of [
    'datasetId',
    'imageId',
    'segmentationModel',
    'segmentationVersion',
    'labelSource',
    'samplingSeed',
    'settingsJson',
    'modelRevision',
    'rawTranscript',
  ] as const)
    if (n[key] !== undefined && typeof n[key] !== 'string') throw Error(`Invalid note ${key}.`);
  if (n.contextCapturedAt !== undefined && !validTime(n.contextCapturedAt))
    throw Error('Invalid context timestamp.');
  if (n.source !== 'manual' && n.source !== 'local-whisper') throw Error('Invalid note source.');
  if (
    typeof n.modelId !== 'string' ||
    !n.modelId ||
    (n.source === 'manual' && n.modelId !== 'manual') ||
    (n.source === 'local-whisper' && n.modelId === 'manual')
  )
    throw Error('Invalid transcription provenance.');
  if (
    n.region &&
    (!finite(n.region.x) ||
      !finite(n.region.y) ||
      !finite(n.region.width) ||
      !finite(n.region.height) ||
      n.region.x < 0 ||
      n.region.y < 0 ||
      n.region.width <= 0 ||
      n.region.height <= 0 ||
      (n.region.level !== undefined && !index(n.region.level)))
  )
    throw Error('Invalid note region.');
  if (
    n.plane &&
    (![n.plane.level, n.plane.t, n.plane.z, n.plane.segmentChannel].every(index) ||
      !Array.isArray(n.plane.channels) ||
      !n.plane.channels.length ||
      !n.plane.channels.every(index))
  )
    throw Error('Invalid note plane.');
  return structuredClone(n);
}

export function exportNotes(notes: VoiceNote[]): string {
  return JSON.stringify(
    { schemaVersion: 1, exportedAt: new Date().toISOString(), notes: notes.map(validateNote) },
    null,
    2,
  );
}

/** Transaction completion, not request success, is the durable-write boundary. */
export class NotesStore {
  private opening?: Promise<IDBDatabase>;
  constructor(private readonly name = 'musivarium-voice-notes') {}

  private open(): Promise<IDBDatabase> {
    return (this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(Error('Local note storage is unavailable. You can still write and export a draft.'));
        return;
      }
      const request = indexedDB.open(this.name, DB_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        // Add new-version migrations here, retaining all older note records.
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onblocked = () => {
        blocked = true;
        reject(Error('Close other Musivarium tabs and retry local note storage.'));
      };
      request.onerror = () => reject(request.error ?? Error('Could not open local note storage.'));
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          this.opening = undefined;
        };
        resolve(db);
      };
    }).catch((error) => {
      this.opening = undefined;
      throw error;
    }));
  }

  async list(): Promise<VoiceNote[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      tx.oncomplete = () => {
        try {
          resolve(
            request.result
              .map(validateNote)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
          );
        } catch (error) {
          reject(error);
        }
      };
      tx.onabort = tx.onerror = () => reject(tx.error ?? Error('Could not read local notes.'));
    });
  }

  async put(value: VoiceNote): Promise<void> {
    const note = validateNote(value),
      db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(note);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(
          tx.error ??
            Error('Local save failed. Storage may be full or blocked; export your draft instead.'),
        );
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? Error('Could not delete local note.'));
    });
  }

  close(): void {
    const pending = this.opening;
    this.opening = undefined;
    void pending?.then((db) => db.close()).catch(() => {});
  }
}
