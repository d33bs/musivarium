# Instance-level segmentation smoke evaluation

This supplements `segmentation.md` with **instance matching and explicit logical-array memory accounting**, without changing either backend. It executes the installed, checksum-verified StarDist ONNX graph through the application's real `segmentModel` CPU/WASM path and compares it with the real `segmentClassical` Otsu path. No generated/fallback output is passed off as model inference.

**Scope:** one public 256 × 256 StarDist test image, 65 annotated nuclei. This is a smoke/performance comparison, **not an independent held-out benchmark**, a dataset-wide accuracy estimate, or a claim that the pretrained model has not seen related data. The application uses raster-mask polygon decoding/NMS, not upstream exact polygon NMS.

## Reproduce

From the repository root, with installed npm dependencies, Node **22.18+** (native TypeScript loading), and Python with `numpy`, `scipy`, and `tifffile`:

```sh
node scripts/setup-model.mjs
PYTHON=python node scripts/benchmark-segmentation.mjs \
  --directory "$TMPDIR/musivarium-segmentation-evaluation" \
  --download --repeats 5
```

Use an explicit writable scratch path if `TMPDIR` is unset. `PYTHON` selects the interpreter; it defaults to `python`. The measured Python versions were Python 3.12.2, NumPy 1.26.4, SciPy 1.12.0 and tifffile 2025.1.10. The script needs SciPy's `linear_sum_assignment(..., maximize=True)`.

`--download` fetches **only missing** pinned TIFFs, at most 2 MiB each, with a 60-second timeout per file; any existing file with a wrong hash is rejected, not silently repaired. Subsequent runs can omit `--download` and need no external network. Inference serves the verified installed weights through an ephemeral loopback HTTP server so the actual application fetch, checksum and session-cache path is exercised. `--model-file` can select an alternative local file, but it must match the same pinned size **and** SHA-256; this is not an arbitrary-model option.

The output directory contains:

- `img2d.tif`, `mask2d.tif`: verified source fixtures.
- `image.f32`, `labels.u32`: original intensities converted to little-endian float32, and reference IDs converted to little-endian uint32. The TIFF image is uint8 and mask uint16; no source intensity scaling or image resizing is applied during conversion.
- `model.u32`, `classical.u32`: actual predicted instance-label buffers.
- `benchmark.json`: full environment and identity record, each matched reference/prediction ID and IoU, raw timing samples, observed tensor dimensions/byte lengths, accounting assumptions and verification outcomes. JSON is also printed to stdout. These derived files are overwritten on a successful rerun; use a separate directory per retained trial.

Both backends use `minArea: 8`. Other settings are the application defaults: model probability > 0.5, raster NMS > 0.3, 48 rays at stride 2, and classical Otsu threshold with 8-connected components. No thresholds were tuned against this mask. All annotated instances, including border objects, are scored; there is no ignored region.

## Instance metric definition

For nonzero reference and predicted IDs, compute the entire pixel-overlap contingency table and:

```text
IoU(reference_i, prediction_j) = intersection / (area_i + area_j - intersection)
eligible match = IoU >= 0.5
```

The independent Python implementation uses SciPy linear-sum assignment with score `eligible * (1 + IoU / (min(n_reference, n_prediction) + 1))`. This first maximizes the number of eligible **one-to-one** matches; among such assignments it maximizes summed matched IoU. Assigned pairs below 0.5 are discarded. The secondary sum is strictly below one, so it cannot trade away an eligible match. This is not pixel accuracy, foreground IoU, or average precision over a confidence sweep.

- `TP`: number of matched pairs; `FP = n_prediction - TP`; `FN = n_reference - TP`.
- Precision = `TP / n_prediction`; recall = `TP / n_reference`; F1 = `2*TP / (n_prediction + n_reference)`.
- A zero denominator gives zero for precision/recall/F1. Binary foreground IoU is reported separately and is one if both foregrounds are empty.
- Object counts exclude ID 0 by value, not by assuming that a background pixel is present or that IDs are contiguous.

A second, independently written JavaScript augmenting-path maximum-cardinality matcher must agree with SciPy's TP/FP/FN. Its tie ordering need not produce the same matched-pair identities; SciPy's tie-breaking defines the reported pairs. Both implementations have eight synthetic regression cases: relabeled perfect masks, splits and merges exactly at IoU 0.5, disjoint objects, empty masks, no predictions, no references and subthreshold overlap.

## Measured quality

Recorded at **2026-11-12T04:23:21.832Z**. Same unmodified float32 image, same reference mask and minimum area for both backends:

| Backend                 | Predicted |  TP |  FP |  FN | Precision @ 0.5 | Recall @ 0.5 |     F1 @ 0.5 | Binary foreground IoU |
| ----------------------- | --------: | --: | --: | --: | --------------: | -----------: | -----------: | --------------------: |
| StarDist ONNX, WASM CPU |        55 |  49 |   6 |  16 |        0.890909 |     0.753846 | **0.816667** |              0.737315 |
| Classical Otsu          |        52 |  45 |   7 |  20 |        0.865385 |     0.692308 |     0.769231 |          **0.769231** |

The model has higher instance F1 on this image; classical has higher binary foreground IoU. These are different measurements: merging or splitting objects can leave a good foreground mask. The equality of classical F1 and foreground IoU here is coincidental; the script computes them independently. One annotated image does not establish general model superiority or a confidence interval across specimens.

## Runtime evidence

Environment: **Apple M4 Pro, arm64 Darwin 25.6.0, Node v26.7.0, onnxruntime-web 1.31.1, WASM CPU, one thread**. These are Node measurements, **not browser measurements**. Other machine load, JIT/GC and OS caches are not controlled.

Each backend has one first-observed call and five subsequent calls; model/classical order alternates by round. Exactly **one inference session and six actual graph executions** were observed. Prediction-buffer hashes were identical across all six runs per backend, and the input image was unchanged.

| Backend        | First call (ms, n=1) | Subsequent calls (ms, n=5)                  | Subsequent median (ms) |
| -------------- | -------------------: | ------------------------------------------- | ---------------------: |
| StarDist ONNX  |              769.180 | 414.790, 411.743, 418.615, 425.231, 408.426 |                414.790 |
| Classical Otsu |                6.527 | 3.188, 5.391, 3.106, 3.164, 3.184           |                  3.184 |

Model first-call time includes loopback model transfer, checksum verification, WASM/session initialization, normalization, graph execution, output packing and polygon decoding. ORT JavaScript module import was separately measured at 5.615 ms and excluded from backend timing. `InferenceSession.create` took 252.155 ms. The first-observed call is not a claim of cold filesystem/network caches or a repeatable cold-start median.

Observed `session.run` times, first then subsequent, were **436.109, 390.733, 391.119, 390.181, 394.952, 390.002 ms**. This narrower stage excludes normalization/packing/decoding; it is not end-to-end latency. Instrumentation wraps the actual ORT methods in this benchmark process and records dimensions and `byteLength` without retaining tensor data. Backend timing includes this small inspection overhead. TIFF conversion, file writing, checks of repeated output hashes and quality matching are outside timing. These samples are local evidence, not a browser/device performance guarantee or a statistically powered speed comparison.

## Memory evidence: logical payload, not browser RSS

The benchmark records **actual input/output tensor dimensions and typed-array `byteLength`** from each real graph execution. The application-source allocations supply the other named array sizes. At this crop size:

| Model array                       | Shape / source                            |         Bytes |        MiB |
| --------------------------------- | ----------------------------------------- | ------------: | ---------: |
| Source float32 image              | 256 × 256                                 |       262,144 |     0.2500 |
| Normalized float32 image          | source allocation, 256 × 256              |       262,144 |     0.2500 |
| Padded graph input                | observed `[1,256,256,1]` float32          |       262,144 |     0.2500 |
| Probability output                | observed `[1,128,128,1]` float32          |        65,536 |     0.0625 |
| Radial-distance output            | observed `[1,128,128,48]` float32         |     3,145,728 |     3.0000 |
| Packed decoder input              | source allocation, 128 × 128 × 49 float32 |     3,211,264 |     3.0625 |
| Returned uint32 labels            | observed 256 × 256                        |       262,144 |     0.2500 |
| **Named model-array payload sum** | not a measured simultaneous live set      | **7,471,104** | **7.1250** |

Additional, separately recorded payloads:

- Serialized ONNX file: **5,891,415 bytes (5.618491 MiB)**. This is file size, not resident model-tensor memory.
- Reference mask used only for scoring: **262,144 bytes (0.25 MiB)**.
- Transient percentile-sort float32 copy: **262,144 bytes (0.25 MiB)**. Its allocation need not coexist with later decoder allocations.
- Classical named arrays: source image 262,144 + result labels 262,144 + component queue 262,144 + visited flags 65,536 + Otsu histogram 1,024 = **852,992 bytes (0.813477 MiB)**. The histogram need not remain live during connected-component labeling.

**These are logical named-array payload sums, not measured peak RAM, a memory budget, browser RSS, JS heap size or WASM linear-memory capacity.** They exclude ORT's resident weights, intermediate neural activations, arena/workspaces and copies, WASM runtime, JS objects/arrays/maps used by polygon decoding, and benchmark/fixture/scoring overhead. Garbage-collection liveness and backend allocations are not observed; adding all named arrays does not prove they coexist. No total-memory or browser-memory ceiling is claimed. Measuring a true browser peak remains outside this evidence.

## Immutable input/output identities

The script rejects the wrong model bytes before inference and also exercises the application's own checksum check during normal loading. TIFF SHA-256 must match before conversion.

| Artifact                                                | SHA-256                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Installed 5,891,415-byte ONNX                           | `90430209afef1fbcede0b1bbd78d37e0ed9edf59cc89ef6d894356e089a5ae36` |
| `img2d.tif` (65,804 bytes)                              | `e599a27b3f4edf119cd838123a8aad5fbbff459790e9849355d2027b361a3dd8` |
| `mask2d.tif` (131,340 bytes)                            | `370583159b88e0cb4f83a17526099972d562f5a9e9fa6148ee68e73885a285e0` |
| `image.f32`                                             | `7fe3f2baaa25c797bb529844a69d24a9607c343a582769743f5e21c837eb5c8a` |
| `labels.u32`                                            | `edaad90ab0aaeba78e2333c69bcc102712d7b22b3666de6023abdadf662ee156` |
| `model.u32`                                             | `5872f0d6a217eb6237df00536bace62cd4a020012df28bd2a5d47b96dc3dcbf6` |
| `classical.u32`                                         | `1ca11c885f754499244adc4ddf2c8105366d1844342216208b4dd326efbb23aa` |
| Application `src/segmentation/index.ts` during this run | `fe2ca9ce348fa94085d2d98299d9cf89705ce796950619f374a473f353a25eda` |
| Benchmark script during this run                        | `7d1bb4591377f6e902d6d07ae30756317d7b7510e51acabe760f441b8180d2c6` |

TIFF provenance is StarDist revision `e80c6de700693bc228ed3c9ba1dc19c3785667ee`, paths `tests/data/img2d.tif` and `tests/data/mask2d.tif`. Weight provenance and licensing remain documented in `segmentation.md`; this evaluation does not establish equivalence to the original TensorFlow model.

## Verification performed

```sh
node --check scripts/benchmark-segmentation.mjs
node scripts/benchmark-segmentation.mjs --self-test
npm test -- tests/segmentation.test.ts --reporter=verbose
```

- Independent matching self-tests: **8 JavaScript + 8 Python cases passed**; both matchers also agreed on TP/FP/FN for each real output.
- Full benchmark: six actual graph runs, one cached session, expected input/output shapes, unchanged input, deterministic full prediction buffers and source hash unchanged during the run.
- Negative CLI checks: a same-size bit-flipped model, a truncated model, a bit-flipped TIFF and zero repeats each exited **1** with the expected specific error. Corrupt copies were isolated in scratch; installed weights and application sources were not modified.
- Existing segmentation suite: **8 passed, 1 optional microscopy test skipped** in its ordinary invocation. The standalone benchmark above actually ran the annotated image; that skip is not used as accuracy evidence.

Only this evaluation document and `scripts/benchmark-segmentation.mjs` are part of this addition. There are no shared-source changes or commits.
