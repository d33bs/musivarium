# Segmentation backends

## API / integration

```ts
import { segmentClassical } from './segmentation/classical';
import { segmentModel, MODEL_ID, MODEL_INFO } from './segmentation/model';

// Both outputs: Uint32Array(width * height), row-major, background 0,
// compact deterministic positive instance IDs, no input mutation.
const labels = segmentClassical(pixels, width, height, { minArea: 8 });
const learned = await segmentModel(pixels, width, height, {
  minArea: 8,
  threshold: 0.5,
  signal,
});
```

`pixels`: `Float32Array | Uint16Array | Uint8Array`. Classical `threshold` means raw intensity, strictly greater than foreground; model `threshold` means object probability. Both default `minArea` to 1. Classical defaults to Otsu; model defaults to probability 0.5. Both reject nonfinite intensities, invalid dimensions and invalid options.

`MODEL_ID = 'stardist-dsb2018-90430209'`. Main implementation is `src/segmentation/index.ts`; `classical.ts` and `model.ts` are stable entry points.

Model inference is real pretrained neural inference, not a threshold method carrying a model label. It explicitly uses ONNX Runtime Web 1.31.1's **WASM CPU execution provider**, single threaded; WebGPU, GPU drivers, cross-origin isolation and a server-side inference API are not required. The parent pipeline can run this module in a module worker. Already-aborted signals fail before model loading; checkpoints reject after loading/inference and before returning results. ORT's in-flight CPU call is not interruptible by an AbortSignal: terminate the pipeline worker for hard cancellation. Classical is an explicit separate fallback; model download/runtime errors are propagated, never silently relabeled as model success.

## Setup and provenance

```sh
npm run setup:assets             # version-matched ORT .mjs/.wasm under public/vendor
node scripts/setup-model.mjs     # bounded, pinned download under public/models
npm test -- tests/segmentation.test.ts
```

No new package is needed beyond `onnxruntime-web`. The download has a 90-second timeout, an exact byte cap, SHA-256 verification and atomic final rename. Re-running verifies the existing file. Browser downloads are also size bounded and SHA-256 checked before session creation. Application assets and weights are local after setup; there is no runtime CDN/model-service dependency. `modelUrl` can override the asset location but cannot bypass checksum verification; `modelBytes` supports offline callers and integration tests, also checksum checked.

| Field           | Value                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact        | `stardist-dsb2018.onnx`                                                                                                                                                                 |
| Host/exporter   | NEPEM-UFSC `dl_models` repository, used by pliman                                                                                                                                       |
| Pinned revision | `c1b1d0d3eb66e09904c2edcce6e0d09523743c00`                                                                                                                                              |
| Bytes           | 5,891,415                                                                                                                                                                               |
| SHA-256         | `90430209afef1fbcede0b1bbd78d37e0ed9edf59cc89ef6d894356e089a5ae36`                                                                                                                      |
| Upstream model  | StarDist DSB2018 fluorescence nuclei, as identified by exporter's model card                                                                                                            |
| Licenses        | Export repository card: MIT; original StarDist model repository: BSD-3-Clause. Original BSD notice retained in `src/segmentation/STARDIST-LICENSE.txt` and installed alongside weights. |
| Input           | float32 NHWC `[1,H,W,1]`, graph name `keras_tensor`, dynamic H/W                                                                                                                        |
| Learned outputs | `prob` `[1,H/2,W/2,1]`, `dist` `[1,H/2,W/2,48]`                                                                                                                                         |

The pinned export is third-party, not an export generated here. Its card identifies DSB2018; equivalence to an independently converted original TensorFlow model has **not** been established. Successful graph execution and microscopy benchmark below are verified; no stronger provenance/accuracy claim is made.

Sources: [pinned export card](https://huggingface.co/datasets/NEPEM-UFSC/dl_models/blob/c1b1d0d3eb66e09904c2edcce6e0d09523743c00/README.md), [download](https://huggingface.co/datasets/NEPEM-UFSC/dl_models/resolve/c1b1d0d3eb66e09904c2edcce6e0d09523743c00/stardist-dsb2018.onnx), [original pretrained models/license](https://github.com/stardist/stardist-models), [StarDist paper and training/model documentation](https://github.com/stardist/stardist), [ORT Web docs](https://onnxruntime.ai/docs/tutorials/web/), [ORT environment flags](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html).

## Processing and limits

- Intended for a **single 2D nuclear fluorescence channel**, one selected z-slice and ROI, not 3D segmentation or whole-cell membrane inference. H&E/RGB and nonnuclear channels are outside this model's supported modality. A nuclear mask is not a whole-cell boundary.
- Preserve source intensities, then normalize using linear-interpolated **1st / 99.8th percentiles**, `(x-p1)/(p99.8-p1+1e-20)`, without clipping. Constant crops become zeros. These are explicit application normalization settings, not a claim about metadata embedded in the ONNX graph.
- Edge-pad to multiples of 16; no image resizing or pixel-scale changes. Maximum model ROI is 1024 × 1024. Label coordinates remain in the original crop frame.
- Decode the 48 learned radial distances at grid stride 2 into star polygons. Greedy descending-probability **raster-mask IoU NMS at 0.3** removes duplicates; higher-confidence instances own overlapping pixels. Apply minimum visible area. This raster implementation is intentionally not claimed to reproduce upstream exact polygon NMS bit-for-bit. There is no watershed or threshold proxy inside the learned backend.
- Classical is Otsu (256-bin histogram) or a supplied raw threshold, 8-connected components and minimum area. It does not separate touching nuclei.
- No halo tiling/merging or scale calibration is implemented. Tight ROI boundaries can truncate nuclei, and this model may underperform when nuclei differ substantially in pixel size or acquisition modality. Large/pathological model candidate counts are rejected rather than allowed unbounded processing.

## Verification and benchmark

Test-first: the segmentation suite initially failed for the absent implementation; subsequent tests exercised Otsu, connectivity/compact IDs, minimum area, immutability, malformed data, normalization, cancellation and polygon NMS. With installed weights the suite also executes the genuine graph using the WASM provider and checks rejection of a deliberately corrupted model. Offline test runs skip the neural integration test when weights are absent; they do not simulate a successful model.

Real microscopy benchmark used the public StarDist test image and reference mask at revision `e80c6de700693bc228ed3c9ba1dc19c3785667ee`, `tests/data/{img2d,mask2d}.tif`, 256 × 256, 65 reference instances. Image SHA-256: `e599a27b3f4edf119cd838123a8aad5fbbff459790e9849355d2027b361a3dd8`; mask SHA-256: `370583159b88e0cb4f83a17526099972d562f5a9e9fa6148ee68e73885a285e0`. This is a smoke/performance comparison, **not an independent held-out evaluation**; the pretrained model may have seen images from the same dataset. Both backends used `minArea: 8` and their default thresholds.

| Backend        | Predicted instances | Binary foreground IoU |                                   Node WASM end-to-end |
| -------------- | ------------------: | --------------------: | -----------------------------------------------------: |
| StarDist ONNX  |                  55 |              0.737315 | 744 ms (new session; WASM runtime already initialized) |
| Classical Otsu |                  52 |              0.769231 |                                                 9.5 ms |

Headless Chromium, macOS, actual browser WASM CPU backend, same 256 × 256 pixels: **754.7 ms first call, 405.8 / 404.0 ms cached-session calls**, always 55 instances. A separate module-worker smoke test also returned a correct `Uint32Array(4096)` background mask for a blank 64 × 64 input. Browser warm timings include normalization, inference and polygon decoding. These local timings are not promises for other machines. Classical had better binary IoU on this fixture; binary IoU ignores instance separation and does not demonstrate model superiority.

To rerun the optional microscopy benchmark, download the pinned two TIFFs into a scratch directory, convert image to little-endian float32 `image.f32` and mask to little-endian uint32 `labels.u32` (for example with Python `tifffile` + NumPy), then run:

```sh
SEGMENTATION_BENCHMARK_DIR=/path/to/scratch npm test -- tests/segmentation.test.ts --reporter=verbose --silent=false
```

Without this variable, unit tests and the installed-weights neural smoke/integrity test still run. The benchmark fixture is deliberately not bundled or downloaded during ordinary unit tests.
