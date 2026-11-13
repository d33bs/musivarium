# Browser-local voice notes

## User path and boundaries

Use the microphone on an individual mosaic tile, or **Voice notes** in the object inspector. The shared **Voice notes** box below the mosaic opens the local library. Record, stop, review/correct the editable transcript, then explicitly save. Manual text entry is available in the same editor without a microphone or ASR model. There is no speech-service fallback.

One tile is annotated at a time; notes contain `selectedCellIds: string[]` so the schema can support a future multi-cell selection without reinterpreting existing records. Opening the voice dialog does not start the microphone or download the ASR model. Recording permission is requested only on **Record note**. Closing/discarding/navigation cancels capture/inference and releases its resources. Unsaved text/recordings prompt before closing; export a draft if browser persistence is unavailable.

The image pipeline, native pixel data, image exports, display renderers and source decoders remain separate. No new UI framework or application backend is introduced. Voice state is not encoded in public share links or image-analysis exports.

## Audio and worker lifecycle

- `recorder.ts`: microphone/AudioContext/AudioWorklet lifecycle and bounded recording; hard 90-second frame budget, warning at 80 seconds in the editor.
- `audio.ts`: actual mono conversion, band-limited resampling to 16,000 Hz, finite/empty/short/silent/clipped input checks and temporary PCM16 WAV preview. A 60-second prepared recording has approximately 960,000 samples, not 2,646,000 relabelled 44.1-kHz samples.
- `asr-client.ts`, `asr.worker.ts`, `asr-config.ts`: lazy local model/inference worker, transferable PCM, loading/ready/transcribing/error progress and termination-based cancellation. The library handles overlapping long-audio chunks; the app does not concatenate overlapping text itself.
- `VoiceNotesPanel.ts`: explicit editable draft, context lock, permission/download/inference/storage error handling, saved library and JSON export.
- `notes-store.ts`: IndexedDB version 1, completed-transaction persistence, explicit upgrade hook and record validation. Notes do not contain audio buffers or image arrays.

Recording/inference cannot overlap an image-processing run. Recording releases the idle image-processing worker, including its StarDist session, without clearing the mosaic or exported measurements. A later sampling run creates a new processing worker. Each ASR completion/error/cancellation terminates its worker; weights can be downloaded/read from browser cache on another note, but the model does not remain resident indefinitely. The npm ONNX Runtime Web dependency is deduplicated to the existing StarDist version; inference workers and their WASM/session memory are still independent.

A first-use notice distinguishes external model downloads from local inference. Model hosts receive normal asset requests and ordinary request metadata (including the client's network address), not microphone samples or transcript text. Notes remain client-side; no raw audio retention is offered. Browser/private-mode cache policy and eviction mean that offline availability is not promised.

## Scientific context and storage

Context is locked at the moment recording starts (before the permission promise resolves), or the first manual text input. Saves/edits retain this snapshot; later settings or selection changes cannot reattach it. Context includes exact image-group URL, stable cell IDs, bounding region, level/T/Z/display and segment channels, segmentation model/version, label source, sampling seed and full serialized sampling settings. Badges and cell-scoped listings use the same segmentation-aware association key: distinct label stores/models/versions and planes do not share notes merely because instance IDs match. Computed masks also distinguish segmentation channel, threshold and window size; seeds and display/crop/filter changes do not rename source-label objects. `contextCapturedAt` records the snapshot time. `createdAt` and `updatedAt` describe the stored note.

The record has `schemaVersion: 1`, a UUID, edited `text`, optional unchanged `rawTranscript`, `source`, model ID and immutable model revision when transcribed. Manual entries use `source: 'manual'` and `modelId: 'manual'`, rather than falsely claiming model provenance. Text is limited to 20,000 characters. Note exports include schema version, export time and all note/context fields; JSON preserves newlines and Unicode. This MVP exports individual, current-cell or all notes; JSON import and tab synchronization are not implemented.

Storage is origin- and profile-specific. A localhost note is not automatically present on GitHub Pages; another browser/profile, browser-data clearing, private browsing or storage eviction can remove it. Export JSON backups. A storage failure keeps the draft editable/exportable and does not break the mosaic.

## Static hosting and browser checks

The application remains a single-page static Vite build. `new Worker(new URL(..., import.meta.url), { type: 'module' })` and Vite-emitted worklet assets handle production hashes; ASR WASM asset URLs resolve against the document's Vite base path, not the worker's `/assets/` directory. The root and `/musivarium/` builds must both be exercised. No API routes, native executable, WebGPU, custom cross-origin-isolation headers or server inference endpoint is needed at runtime.

Microphone capture requires HTTPS or localhost, a usable device and permission. A restrictive custom CSP must permit same-origin JS/workers and WASM execution, plus model GET requests to Hugging Face and its redirected asset/CDN hosts. There is no new CSP restriction in the existing Pages app. Adding a strict CSP requires observing the exact redirect hosts and browser WASM policy, not assuming `huggingface.co` alone is sufficient.

Automated UI protocol controls and synthetic audio signals are explicitly identified in tests; they are not evidence of real speech recognition. Real model evaluation and its scope are recorded in `voice-evaluation.md` and compatibility evidence in `voice-asr-compatibility.md`. Actual microphone acoustics, human accents, scientific dictation accuracy, exact deployed-origin CORS and unsupported/unexercised browsers remain separate validation gates.

## Verified implementation checks

Verification on November 13, 2026:

- `npm run check`: typecheck, 111 unit/scientific tests passed, one opt-in pre-existing segmentation benchmark skipped, production build passed.
- Full Playwright suite: 88 tests passed in Chromium and Firefox, no failures/flakes/skips. Coverage includes real AudioWorklet/worker capture with simulated devices, 44.1/48-kHz conversion, 90-second DSP limits, permission settlement/discard races, model protocol failure/cancellation, local persistence/context/edit/delete/export, mobile layout/keyboard handling, serialized local mutations, failed/empty-transcript audio discard protection and cross-label-source note/badge isolation.
- Production static smoke: Chromium and Firefox both passed root and `/musivarium/` builds, real IDR crops, actual StarDist inference and Parquet exports. The production voice worker was loaded only after recording; an intentionally blocked model download preserved manual notes, original image functionality, persistence and JSON exports. Evidence: `$HOME/.hermes/cache/scratch/musivarium-voice-static/`.
- Actual installed Google Chrome 157.0.8103.39 completed the full repository-prefix UI path with a genuine browser fake-capture device reading synthetic speech: record 40.1 seconds, stop, actual local Whisper transcription, correct text, save, export, refresh/recover and rerun StarDist. Stop-to-editable-transcript took 6,627 ms on this development machine, including first model load. Microphone/preparation/ASR workers closed; StarDist still worked afterward. There were no page errors and only GET requests. This is a synthetic-speech/device control, not a human microphone/accuracy claim. Evidence: `$HOME/.hermes/cache/scratch/musivarium-voice-full-ui/evidence.json`.
- Actual model compatibility, immutable downloaded weight hashes, native long-audio chunk merging, download/inference cancellation/retry and a cached external-network-blocked run are independently documented in `voice-asr-compatibility.md`.

Microsoft Edge is not installed on this machine. Actual Safari and physical microphone/human speech validation have not been performed. Browser-engine coverage must not be reported as actual Edge/Safari testing. The new feature has not been published to GitHub Pages; final deployed-origin validation remains gated on reviewed commit/push/publication authorization. Benchmark corpus results and memory limitations are recorded separately in `voice-evaluation.md`. A detected decoder-repetition loop shows a review warning in the editor (`src/voice/quality.ts`); see `voice-asr-quality-investigation.md` for the root-cause finding and why production chunk settings were not changed.

## Verification commands

```sh
npm ci
npm run setup:assets
npm run check
npm run test:browser
npm run test:static
node scripts/benchmark-voice.mjs
npm run format:check
```

The reference evaluation generates clearly labelled synthetic speech, not microscopy and not human-accuracy validation. It downloads actual speech model weights on first use. Do not run it as part of the offline unit/browser test suite. Timing and memory conclusions must name their browser, hardware, cache state and measurement limitations. No new deployment is authorized by the earlier deployment of the existing main commit: commit/push/publication remain a separate review gate.
