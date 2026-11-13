# Local voice evaluation

## Outcome: runtime completed; long-note quality failed

**These are ten synthetic-speech clips, not human speech, microphone accuracy, clinical validation, or a real-device/browser support certification.** All ten completed genuine Whisper inference in a local browser on November 13, 2026. The 90-second clip produced a large repetitive hallucination: **152.08% word error rate (WER)**. The harness intentionally exits **2** for this quality-review failure, even though inference returned successfully. This result must not be described as passing ASR accuracy validation.

Across the ten distinct clips, word-weighted WER was **30.80% (422 edits / 1,370 reference words)**. The first nine clips alone had 5.04% WER (57 / 1,130); that diagnostic subset does not replace the complete result. The repeated 30-second cold/warm clip is counted only once in the aggregate.

No commit, push, live deployment, or publication was performed. The exact future publication origin, production bundle, and browser-specific microphone behavior remain separate gates.

## Reproduce

Run from the repository root with the existing npm dependencies, Playwright Chromium, project model/vendor assets, an installed macOS `say` **Samantha** voice, and `ffmpeg` on `PATH`:

```sh
node --check scripts/benchmark-voice.mjs
node scripts/benchmark-voice.mjs --self-test
node scripts/benchmark-voice.mjs
```

The last command synthesizes the audio and runs the browser. It does not install packages or download voices. Initial Whisper weights are fetched from the pinned Hugging Face revision; inference runs locally. If the required voice is absent, the command stops rather than requesting a voice download. Asset/dependency setup remains the project's existing setup procedure, not a second installer embedded in this benchmark.

Useful narrower commands:

```sh
# Generate the ten WAV/PCM files without starting inference.
node scripts/benchmark-voice.mjs --generate-only

# Reuse verified audio; still launch a fresh browser/context for the cold trial.
node scripts/benchmark-voice.mjs --reuse-audio

# A deliberately labelled partial run, not a ten-clip result.
VOICE_CLIPS=synthetic-10-long-review-90s node scripts/benchmark-voice.mjs --reuse-audio
```

Configuration:

- `VOICE_EVIDENCE_DIR`: audio and run evidence directory; default is `$HOME/.hermes/cache/scratch/musivarium-voice-evaluation`.
- `VOICE_PORT`: loopback Vite port, default **5197**; port 5183 is explicitly rejected to avoid another local verification server.
- `VOICE_TIMEOUT_MS`: transcription deadline, default **180000** milliseconds per clip; cancellation terminates the real ASR worker. The browser launch is bounded at 30 seconds. Browser UI/navigation preparation has separate bounded waits.
- `VOICE_CLIPS`: comma-separated exact IDs; any unknown ID fails validation. A subset is explicitly reported as partial.
- `FFMPEG`: optional executable override.

Exit status: **0** means the selected inference trials completed without the severe repetition/WER review flags; **1** means a harness, network, or inference failure/incomplete selection; **2** means inference completed but severe transcript-quality review flags were found. A zero exit is not a general accuracy threshold or proof of correct overlap handling. Normal spelling/domain errors are retained in WER rather than silently corrected.

`--self-test` executes the WER insertion/deletion calculation and duplicate-anchor detector. It is a benchmark-helper self-test, not a replacement for application tests.

## Audio and references

`scripts/voice-reference.json` contains all reference text and segment durations. The generator uses `/usr/bin/say -v Samantha -r 145`, converts AIFF to **16 kHz mono Float32 PCM**, and makes listenable 16-bit PCM WAV files. FFmpeg `atempo` adjusts each original paragraph to its assigned duration while preserving pitch; a small final interpolation corrects residual sample-count rounding. The source/target duration and both adjustment ratios are saved for every segment.

Each note is new continuous prose, not a short repeated clip or a long silent recording. Exact durations are **30, 30, 40, 45, 50, 60, 60, 70, 80, and 90 seconds**: 555 seconds total. Text includes nucleus, cytoplasm, segmentation, Zarr, StarDist, fluorescence, and morphology. Distinct review phrases begin in segments at approximately **24, 49, and 74 seconds** when the note is long enough. The saved time is the segment start, not a forced-aligned word timestamp; natural onset silence remains.

Observed segment speech rates were 110–187.5 reference words/minute. A simple energy audit found 91.8–93.9% of 20 ms frames above RMS 0.003. This is an audio-energy check, **not** a human/VAD annotation or a guarantee that synthesis pronounced every scientific word as intended. Exact clip lengths do not validate real microphone capture limits; actual 30/60/90-second recorder tests are independent.

The generated reference-manifest SHA-256 is:

```text
16e7424655e859fc777e99f1795a2b23a5301eea740f75e12ea4552eb92968d3
```

Every PCM file has its byte count and SHA-256 in `clips.json`; each trial repeats the input hash and includes a transcript SHA-256. Regeneration can differ with the macOS voice/FFmpeg version, so compare actual hashes instead of assuming cross-machine binary identity. Even a formatting-only change to the reference JSON invalidates `--reuse-audio` until regeneration.

## What the browser actually exercises

1. Start the actual application through Vite, with HMR disabled and a separate per-run dependency cache. This is **development-module validation**, not a production/static deployment test.
2. Intercept IDR requests using the original `tests/browser/fixtures/idr0076` manifest, verifying every fixture's byte count and SHA-256, as in `scripts/smoke-static.mjs`. These are original microscopy responses served from local fixtures, not synthesized biological data or live IDR service measurements.
3. Run the real UI's small **256-pixel StarDist model** path and require model provenance `stardist-dsb2018-90430209` and a positive model-inference duration.
4. Start and cancel the UI's fake-device recording solely to exercise the production `prepareRecording` callback. A transparent Worker subclass records lifecycle calls and verifies that the idle image worker was terminated. The benchmark does **not** manually terminate it to fake this gate.
5. Load each verified PCM array into the actual `AsrClient.transcribe` from `src/voice/asr-client.ts`. No transcript/model response is mocked. This direct-PCM step excludes microphone, recorder, worklet, and resampling accuracy. Fake microphone permission/device is used only for preparation/cancellation.
6. Repeat the first clip after a page reload in the **same browser context**, rerunning StarDist and its production release first. Remaining clips use the same context/cache but a new real ASR worker, matching the client's short-lived worker behavior.

StarDist ran twice in the final evaluation: 1,012.4 ms initially and 276.7 ms after reload, with three returned objects each time. Both production image-worker releases were observed. No deliberately resident-StarDist/direct-client worst-case comparison was run; these results must not be labelled a simultaneous two-model stress test.

The actual speech model was `onnx-community/whisper-tiny.en`, revision `794207fec2761281fe63a23a94b7e9f53a4efbc1`, q8, WASM with one thread. The application used Transformers.js 4.3.2 and shared ONNX Runtime Web 1.31.1. Its chunk options were 25-second windows with a 5-second stride on each side. Review phrases near multiples of 25 seconds are probes, not an assertion that every internal merge occurs exactly there.

## Recorded run

Final evidence: `$HOME/.hermes/cache/scratch/musivarium-voice-evaluation/run-2026-11-13T16-23-49-625Z/`.

- Start: **2026-11-13T16:23:49.627Z**; finish: **2026-11-13T16:24:58.494Z**.
- Host: Apple M4 Pro, arm64, 12 logical CPUs, 51,539,607,552 physical-memory bytes; observed Darwin kernel 25.6.0; Node v26.7.0.
- Browser actually executed: Playwright **Chromium headless shell 158.0.8127.18**, `chromium_headless_shell-1254`, not installed branded Chrome, Edge, or Safari. No claims are made for those unexecuted browsers, WebKit, Firefox, mobile, or low-memory hardware.
- Eleven completed inference trials covering ten unique clips. There were no harness/page/network failures in this final run and no console errors/warnings. Source/lock/script hashes were unchanged between the start and end of the run.

All measurements below are individual trials, not statistical medians. ASR load includes import/model initialization; inference time excludes the preceding StarDist run and audio generation. The JSON also records total client wall time.

| Synthetic clip    | Seconds | Cache                        | Load ms | Inference ms |         WER | Edits / words |
| ----------------- | ------: | ---------------------------- | ------: | -----------: | ----------: | ------------: |
| 01 nucleus        |      30 | Fresh-context first observed |  3548.3 |       2564.8 |       9.52% |        6 / 63 |
| 01 nucleus repeat |      30 | Same context, after reload   |   455.0 |       2620.6 |       9.52% |        6 / 63 |
| 02 cytoplasm      |      30 | Warm, new worker             |   438.1 |       2576.6 |       0.00% |        0 / 67 |
| 03 segmentation   |      40 | Warm, new worker             |   419.0 |       2763.4 |       3.13% |        3 / 96 |
| 04 Zarr           |      45 | Warm, new worker             |   433.0 |       3925.0 |       4.72% |       5 / 106 |
| 05 StarDist       |      50 | Warm, new worker             |   444.5 |       3995.5 |       9.48% |      11 / 116 |
| 06 fluorescence   |      60 | Warm, new worker             |   476.1 |       5464.3 |       5.26% |       8 / 152 |
| 07 morphology     |      60 | Warm, new worker             |   433.6 |       5323.6 |       3.29% |       5 / 152 |
| 08 quality        |      70 | Warm, new worker             |   429.4 |       5544.6 |       6.15% |      11 / 179 |
| 09 comparison     |      80 | Warm, new worker             |   441.9 |       6827.1 |       4.02% |       8 / 199 |
| 10 long review    |      90 | Warm, new worker             |   426.2 |      10408.0 | **152.08%** | **365 / 240** |

WER is word-level Levenshtein `(substitutions + deletions + insertions) / reference words`. Lowercase Unicode letters/numbers are retained, apostrophes removed, and other punctuation treated as spaces. No domain aliases, number expansion, spelling correction, or special handling of Zarr/StarDist improves the score. WER can exceed 100% when a model inserts many words. The full token alignment is saved, not only a rounded score.

## Boundary/repetition review and failure

**11 of 17 exact boundary phrases occurred exactly once** across the unique clips. No exact complete anchor phrase was duplicated. Six phrases failed exact matching; this means missing or misrecognized text, **not automatically an overlap-deduplication defect**. Saved local token alignments support manual inspection:

- Clip 05, 24 s: “copper meadow marks” was mangled, including `metomarks`.
- Clip 06, 49 s: “scarlet pebble” became spelling/recognition variants including `scarlett` and `pabel`; nearby Zarr terminology also failed.
- Clip 08, 24 s: “focus check” became “focus track”.
- Clip 09, 49 s: “saffron” became `safron`.
- Clip 10, 49 s: “azure” became `asher` after a large repeated passage.
- Clip 10, 74 s: “plum” became `plumb`.

The 90-second transcript repeatedly emits “the third one”; the six-word span `the third one the third one` appears **75 times**. Its 365 errors comprise **33 substitutions, one deletion, and 331 insertions**. The reference/audio does not contain this repeated passage. The same severe 90-second result occurred in the earlier completed runs as well. This establishes an observed synthetic-workload failure, not its root cause: this harness cannot distinguish decoder hallucination from a chunk-merge/runtime issue without chunk-level model output. No ASR source or decoding setting was changed to hide it. Full transcripts remain in the evidence for review.

## Downloads, CORS, and data egress

The fresh ASR trial observed **41,519,299 remote response-body bytes** over 32 remote responses, including model/tokenizer/config responses, redirects, and HEAD/range probes. This is the sum reported by Playwright `request.sizes().responseBodySize`, not an on-wire/TLS bill or exclusively model weights. Local JS/WASM/PCM responses and locally fulfilled IDR fixtures are reported separately in the raw response list and all-response sum.

After same-context reload, the repeated ASR trial observed **zero remote responses / zero remote response-body bytes**. Each remaining warm ASR trial also observed zero remote responses. The named `transformers-cache` Cache API entries were enumerated in the report. A new worker still initializes a new session; “warm” here means browser Cache API reuse, not a surviving in-memory ASR model. Routing disables ordinary browser HTTP caching, so this isolates Cache API behavior; a fresh context does not flush CDN or operating-system caches.

Actual readable cross-origin model fetches and successful inference verified CORS from **`http://127.0.0.1:5197`**. Model/CDN response headers recorded the local origin or `*`. This does not verify a future GitHub Pages origin, its base path, or its deployment headers.

Every observed request was GET or HEAD with no request body; **zero audio/transcript uploads were observed**. The router rejects other methods, request bodies, and unexpected remote hosts. PCM travels only from the loopback server to the browser. This is evidence for the exercised configuration, not a universal security proof. Source and request records are available for independent review.

## UI heartbeat and memory: observations, not guarantees

A 50 ms main-thread timer and `requestAnimationFrame` ran throughout each ASR trial. The largest observed timer interval was **52.0 ms**; the largest animation-frame gap was **16.8 ms**. Those probes show the local page remained responsive during this workload, not the latency of every user interaction or real-device recording.

Memory was sampled once per second, with **67 samples** across setup/inference:

- Highest observed Chromium process-tree RSS **sum**: **1,755,201,536 bytes (1,673.89 MiB)**, including the browser and descendant processes, the existing application/image results, workers, WASM, and shared mappings. PIDs, executable paths, and each process RSS are saved. Shared pages may be counted multiple times; short spikes between samples may be missed. This is neither exclusive ASR memory nor a measured upper bound on peak physical memory.
- Highest observed CDP **page JavaScript heap**: **8,557,300 bytes (8.16 MiB)**. This excludes worker heaps and WASM/model allocations. It must not be labelled total browser memory or peak ASR memory.

**Actual peak exclusive/process/WASM memory is unmeasured; no numeric safety bound is established.** The observed RSS also does not establish that a worker release immediately returned all allocator pages to the OS. Production release was verified by actual lifecycle calls, not inferred from a small page heap.

## Evidence, limits, and retained failures

The directory contains `clips.json`, all ten `.wav`/`.f32` clips, intermediate synthesis segments, and timestamped run directories. Each successful run directory contains `results.json`, `browser-after-evaluation.png`, and its isolated Vite dependency cache. The results include actual browser/host versions and date, source/input/transcript hashes, complete reference/transcript/alignment, boundary contexts, load/inference/wall timings, progress callbacks, request/response metadata and bytes, worker release records, interval/frame heartbeat, per-process RSS, CDP heap samples, and quality/runtime failures.

An intermediate attempt, `run-2026-11-13T16-13-32-987Z`, retained partial evidence of an aborted optimized Transformers import (`net::ERR_ABORTED`) and then hit the outer command timeout while waiting for response-metric cleanup. The final harness uses a per-run Vite cache rather than sharing optimized dependency files with parallel servers and bounds metrics cleanup at five seconds. Subsequent complete runs exercised that configuration; the interrupted attempt is not counted as successful. A formatting-only reference change also correctly triggered the stale-audio guard before inference, followed by regeneration.

The scratch location is not durable archival storage and may be pruned. Copy the evidence to an approved durable location if it must survive cache cleanup; generated binary clips are deliberately not committed. Only the reproducible script, text reference JSON, and this document belong in the repository.

Remaining work is explicit: human speech/noise/accent validation, actual microphone/worklet capture and 30/60/90-second limits, lower-memory devices, other engines/branded browsers, durable evidence retention, static production/root/project-prefix validation, exact-origin publication CORS, and diagnosis of the 90-second repetition. **Do not publish or promote this benchmark as an accuracy pass.**

## Root-cause follow-up

The 90-second repetition was investigated directly (see `docs/voice-asr-quality-investigation.md`): it is a genuine Whisper Tiny English decoder hallucination on this clip's content, reproduced across several chunk/stride configurations with the real installed model, not a chunk-merge defect unique to the 25 s/5 s default. No production chunk setting was changed, since the alternate settings that happened to avoid the loop also silently dropped real trailing audio. The application now detects likely repetition loops (`src/voice/quality.ts`) and warns in the Voice notes editor before saving, rather than attempting to rewrite the transcript.
