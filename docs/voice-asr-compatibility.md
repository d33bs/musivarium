# Browser Whisper ASR compatibility

Verified **2026-11-13** using the publisher's npm metadata, Hugging Face model API, installed package source, and actual production-built browser inference. This is a compatibility/execution check, **not a human-speech accuracy benchmark**.

## Exact pins and assets

- `@huggingface/transformers`: **4.3.2**, the npm `latest` version returned on the verification date.
- Publisher's declared ORT Web dependency: `1.31.0-dev.20260914-8d85527a0`.
- Application's override: **onnxruntime-web 1.31.1**. `npm ls @huggingface/transformers onnxruntime-web` returned one deduplicated Web runtime. Real inference below succeeds with this override; no second runtime package is needed.
- Vite **8.3.8**, TypeScript **5.9.3**.
- Model: **onnx-community/whisper-tiny.en**.
- Immutable revision: **794207fec2761281fe63a23a94b7e9f53a4efbc1**, obtained from the actual Hugging Face API.
- Execution: `device: 'wasm'`, `dtype: 'q8'`, `numThreads: 1`, `proxy: false`, in a dedicated module worker. No WebGPU requirement, cross-origin isolation, local filesystem model paths, or hosted inference.

The actual browser-downloaded ONNX responses were read from `transformers-cache`, SHA-256 hashed with Web Crypto, and compared to Hugging Face LFS metadata:

| Repository file                            |    Bytes | SHA-256                                                            |
| ------------------------------------------ | -------: | ------------------------------------------------------------------ |
| `onnx/encoder_model_quantized.onnx`        | 10124993 | `e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25` |
| `onnx/decoder_model_merged_quantized.onnx` | 30718858 | `c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52` |

Runtime requests used the application's existing `public/vendor` assets. Their hashes match the installed ORT 1.31.1 distribution and `public/vendor/manifest.json`:

| Runtime file                  |    Bytes | SHA-256                                                            |
| ----------------------------- | -------: | ------------------------------------------------------------------ |
| `ort-wasm-simd-threaded.mjs`  |    24738 | `30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3` |
| `ort-wasm-simd-threaded.wasm` | 14848852 | `4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d` |

`setup-assets.mjs` already copies both required files; no script edit was necessary. Transformers.js's package bundle also causes Vite to emit an unused `ort-wasm-simd-threaded.asyncify-*.wasm` (28747738 bytes). The network trace asserts it is **not fetched**: explicit `wasmPaths` select the two existing vendor files. This is unused build output, not another runtime actually initialized.

## Important upstream revision-discovery pitfall

In the installed 4.3.2 publisher source, `pipeline()` passes `revision` to component loading, but its initial `get_pipeline_files()`/metadata discovery omits that option. `get_tokenizer_files()` and `get_processor_files()` also discover metadata with default options. Using only `pipeline(..., { revision })` therefore generated `/resolve/main/` requests and failed the cached/external-network-blocked validation.

The worker additionally fixes `env.remotePathTemplate` to `{model}/resolve/794207fec2761281fe63a23a94b7e9f53a4efbc1/`. Both discovery and actual downloads now use immutable URLs. Tests assert the setting and reject any `/resolve/main/` network request. This is worker-local configuration, not a dependency patch.

The release-named GitHub raw source URLs tried during verification returned HTTP 404, so the exact installed npm release source is the version-specific authority here rather than an assumed Git tag. Relevant files are `src/pipelines.js`, `src/utils/model_registry/get_tokenizer_files.js`, `get_processor_files.js`, and `src/utils/dtypes.js` in the package. The latter maps `q8` to `_quantized` filenames.

## Client lifecycle and privacy

- Importing/constructing `AsrClient` starts no worker and loads no ASR runtime or weights.
- Input is finite mono `Float32Array` PCM, already resampled to 16000 Hz, at most 90 seconds. Passing a full ordinary array may detach its buffer. Views are copied before transfer so unrelated samples are not transferred.
- Worker and HF module creation happen only on `transcribe()`. Runtime URLs resolve against the page's `document.baseURI` and Vite base, not the worker's `/assets/` directory.
- File names and byte progress are forwarded, followed by `ready` and `transcribing`.
- Whisper's supported `{ chunk_length_s: 25, stride_length_s: 5 }` path handles overlap and token merging; the application does not concatenate manually transcribed chunks.
- `cancel()` terminates the worker during both downloads and inference and rejects the pending promise with `AbortError`. Stale messages/IDs cannot settle a later request.
- Success, model failure, worker crash, message decoding failure, and transfer failure release the worker. Model/OOM failures have retry guidance. Consumer progress callback exceptions do not leak it.
- HF remote access downloads model assets only. No audio is submitted to an API. Browser network traces contained GET requests only; no telemetry endpoints or hosted inference calls were observed. ORT Web exposes no telemetry-disable property; the worker disables filesystem loading/caching and experimental cross-origin storage rather than inventing such a flag.
- Browser Cache API retains downloaded model/runtime assets; terminating a worker frees its model/WASM execution state, not the persistent download cache.

## Genuine production-browser evidence

The standalone harness builds the real client/worker with Vite, serves it at a nested `/musivarium/` deployment path without COOP/COEP, and runs real downloaded weights. It records exact model hashes, network requests, progress, cancellation results and worker closure events. It asserts no startup worker/model downloads, cancels during an ONNX download, retries successfully, cancels during transcription, then retries with **every HTTPS/external request blocked** while keeping local application scripts reachable.

Both tested browsers reported `crossOriginIsolated: false`, produced the same short transcript, returned `AbortError` for both cancellations, closed all four workers, and logged no browser console errors. No external request was needed on the cached run. Full application offline boot is **not** claimed: blocking localhost as well prevents a new worker script from loading without an offline application installation/service worker.

Synthetic input was generated with macOS `say -v Samantha`, converted using `afconvert` to mono PCM16 WAV at 16000 Hz:

- Short: **3.62275 s**, WAV SHA-256 `9b3393123795ec7905831cf23084812b38bca9d312ebb0697fc4c3eb8cef498e`.
- Short prompt: “The cells in this image look healthy. Save a note for this experiment.”
- Short actual output: “cells in this image look healthy. Save a note for this experiment.” The initial “The” is missing; this is not perfect transcription evidence.
- Long: **48.0013125 s**, WAV SHA-256 `3ab7fd335de223f972039466b6048c1294fb211eca96903a287ccf5d8e05d398`. This crosses several native overlap windows; its returned transcript reached the final clause “the correct experiment.” No manual concatenation was used.

Measured wall-clock milliseconds from actual `performance.now()` results:

| Browser / synthetic input             | Successful retry load ms | Transcription ms | Cached/external-blocked load ms | Cached transcription ms |
| ------------------------------------- | -----------------------: | ---------------: | ------------------------------: | ----------------------: |
| Chromium 158.0.8127.18 / 3.62275 s    |                   1593.3 |           1080.7 |                           392.1 |                  1107.6 |
| Firefox 159.0 / 3.62275 s             |                     1889 |             1128 |                             479 |                    1110 |
| Chromium 158.0.8127.18 / 48.0013125 s |                   1581.6 |           3975.1 |                           389.5 |                  3968.4 |

The first successful load follows the intentional cancelled-download test and may benefit from HTTP caching. These are individual developer-machine observations, **not cold-start benchmarks, mobile performance claims, measured peak memory, or a 10–20 sample human-accuracy evaluation**. StarDist coexistence scheduling remains the caller's responsibility; the client releases all of its workers after each operation.

Raw execution JSON on the verification machine:

- `/Users/buntend/.hermes/cache/scratch/musivarium-asr-validation/evidence-chromium.json`
- `/Users/buntend/.hermes/cache/scratch/musivarium-asr-validation/firefox/evidence-firefox.json`
- `/Users/buntend/.hermes/cache/scratch/musivarium-asr-validation/long/evidence-chromium.json`

## Reproduce

```sh
npx vitest run tests/voice-asr.test.ts
npm run typecheck
say -v Samantha -o "$HOME/.hermes/cache/scratch/musivarium-asr-synthetic.aiff" \
  'The cells in this image look healthy. Save a note for this experiment.'
afconvert "$HOME/.hermes/cache/scratch/musivarium-asr-synthetic.aiff" \
  "$HOME/.hermes/cache/scratch/musivarium-asr-synthetic.wav" -f WAVE -d LEI16@16000 -c 1
ASR_TEST_WAV="$HOME/.hermes/cache/scratch/musivarium-asr-synthetic.wav" \
  ASR_EXPECT_TEXT='cells in this image look healthy' \
  node tests/support/validate-voice-asr.mjs
# For Firefox add ASR_BROWSER=firefox and a distinct ASR_TEST_OUTPUT directory.
```

The harness uses a dynamically assigned localhost port (not application browser-test port 5183), writes its build/evidence into the Hermes scratch directory, leaves application `dist` untouched, and requires installed Playwright browsers. A real network connection is required for the initial weight download. Synthetic speech fixtures are not committed.

## Publisher references retrieved

- npm current release metadata: `https://registry.npmjs.org/@huggingface/transformers/latest`
- Actual repository revision and LFS metadata: `https://huggingface.co/api/models/onnx-community/whisper-tiny.en?blobs=true`
- Pinned model card: `https://huggingface.co/onnx-community/whisper-tiny.en/raw/794207fec2761281fe63a23a94b7e9f53a4efbc1/README.md`
- Official ASR pipeline API (documents chunk/stride options): `https://huggingface.co/docs/transformers.js/api/pipelines`
- Exact installed 4.3.2 package source and ORT 1.31.1 `onnxruntime-common/lib/env.ts` for runtime-path, threading and proxy flags.
