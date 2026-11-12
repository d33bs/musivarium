# musivarium

A browser-only microscopy explorer: sample a 2D region, find labelled objects, and inspect a reproducible mosaic of single-object crops. No application backend, volume rendering, or Z projection.

## Run locally

Node.js 22.18 or newer is required.

```sh
npm ci
npm run setup:assets
npm run dev
```

Open the localhost address printed by Vite. Asset setup copies the pinned DuckDB/ONNX runtimes and downloads a checksum-verified 5.9 MB StarDist model. Generated binaries are ignored by Git; do not skip setup on a clean checkout. The default label workflow does not need neural inference, but setup prepares every advertised backend.

1. Open the page: **IDR0076 / verified cell labels** loads automatically and collects up to 100 objects. Settings start collapsed so the mosaic gets the full width.
2. Use **Show settings** to choose another preset (loads automatically) or adjust sampling controls, then **Sample objects** to apply manual edits. **Shuffle & sample** and **Cancel** stay visible outside the sidebar.
3. Change order, area/intensity filters, channel visibility, contrast, context and outlines without downloading the image again. Click a crop to inspect its mask, source region, coordinates, native measurements and physical scale.
4. Copy a reproducible URL or export the visible objects. SQL returning `cell_id` selects objects in the mosaic; aggregate queries display a table instead. SQL itself is local, not part of a shared URL.

A shared URL restores the sampling/display settings and loads the mosaic automatically. Invalid shared settings show an error without silently loading default data. Use Cancel to stop an automatic load.

## Included real datasets

- **IDR0076 / 10501752:** 50-channel 2D breast-tumour tissue image with matching cell-section instance masks. Default display is channel 42, DNA1-191Ir; this intentionally overrides that channel's inactive metadata flag. Ali et al., CC BY 4.0. No calibrated spatial unit is supplied, so coordinates remain pixels.
- **IDR0033 / BR00109990_C2 / image 0:** the supplied NGFF 0.5 Cell Painting source. Five channels, already 2D (`c,y,x`), with no Z axis or existing masks. Choose pretrained StarDist nuclei segmentation or the classical baseline. Nuclei are not whole-cell boundaries. Direct chunk downloads have shown transient interruptions; the reader retries once and never substitutes data or a different backend.

The checked-in [manifest](public/datasets.json) records verified versions, shapes, channels, transforms and defaults. [Dataset qualification](docs/dataset-qualification.md) contains original-byte and independent Python evidence.

## What runs where

- **Zarrita 0.7.5:** bounded original OME-Zarr chunk decoding in a module worker.
- **Existing labels:** aligned native instance IDs; no inference.
- **StarDist DSB2018:** real, pinned ONNX inference using single-threaded CPU/WASM, not WebGPU. A 2D nuclear-fluorescence model with rasterized instance postprocessing. See [model limitations and provenance](docs/segmentation.md).
- **Classical:** Otsu/raw-threshold + 8-connected components. Touching objects can merge; not presented as a neural model.
- **DuckDB-WASM:** queryable object metadata and actual CSV/Parquet serialization.
- **DuckDB-Zarr image backend:** deliberately unavailable. The audited binary fetched every chunk despite a cropped SQL `WHERE`; explicit bounds rejected positional OME axes. It also did not match the app runtime's C API. See [reproducible audit](docs/duckdb-zarr.md). No full-volume workaround or silent fallback is enabled. This is the plan's explicit delivery fallback, not completion of the extension port.

## Scientific and resource constraints

One explicit time index and one Z index are selected; absent axes accept only index 0. Sources that pack multiple Z/time indices per chunk are rejected. Only intersecting XY chunks and selected channels are requested; a chunk can be larger than a requested region. Existing image/label shapes, scale and translation must match; unsupported mappings are rejected rather than silently resampled.

A live reading panel shows received bytes, discovered response sizes when available, active/queued requests, retries and elapsed time. Unknown sizes remain indeterminate instead of displaying an invented job percentage. Metadata, selected channels and aligned labels overlap within one shared four-request limit; aggregate decoded-chunk reservations are capped at 64 MiB. No future regions, extra channels, Z slices or volumes are prefetched. Crops and the inspector render in grayscale regardless of source channel metadata colors; object-of-focus outlines are green and enabled by default, only the selected instance is outlined, and saved display URLs still honor an explicit outline toggle.

Native pixel arrays and label IDs are preserved. Means use only the object's pixels, not the padded crop. Areas are selected-level pixels²; coarse-level segmentation is labelled exploratory. Source pixel-index coordinates map to physical coordinates as `translation + scale × index`. Display contrast and colors do not change measurements. Native crops are centered, at least the requested minimum size, expanded for large objects and clipped at the sampled region boundary; the actual shape and crop origin are exported.

Sampling shuffles a non-overlapping image partition, then seeded object candidates within each region. It stops at the target or tile budget. Region sampling is **not uniform cell sampling**, and a mosaic is not a statistically representative cohort. Border objects are excluded by default. Stable image/label IDs deduplicate existing instances; inferred labels are scoped to region and backend.

Limits: 32 regions, 128/256/512 px region sizes, 1–4 selected channels, target 1–1000 objects, four concurrent chunk requests, one segmentation job, 24 MiB compressed cache per source, 16 MiB per HTTP object, 64 MiB aggregate decoded-chunk reservation across concurrent reads, 96 MiB image+label response budget, and 48 MiB retained crop/mask arrays. These are logical budgets, not a browser process-memory guarantee. Runtime/model memory is additional. Cancellation terminates the processing worker; successful runs retain the idle model session for the next sample. No partial run is exported after cancellation or failure.

## Exports

- **CSV / Parquet:** native measurements and source/region/plane, instance ID, segmentation/model version, channels, raw means, seed, complete run settings and crop geometry. For object queries they match the visible mosaic; an active aggregate query exports that result table instead.
- **Native crops ZIP:** one directory per visible object, row-major native-dtype `.npy` channels, uint32 label plane including neighboring objects, and a full manifest. Use the selected instance ID to isolate an object. No JPEG/intensity quantization.
- **PNG:** display-normalized mosaic or selected-object preview, not raw quantitative data.
- **Run JSON:** source metadata, sampling settings, transforms, actual requested objects/bytes, timings, warnings, visible IDs and display/query state. Save this alongside exports for durable reproducibility if a remote source changes.

## Verify

```sh
npm test
npm run build
npx playwright install chromium firefox
npm run test:browser
npm run test:static
npm run validate:reference
npm run format:check
npm audit --audit-level=moderate
```

Unit/scientific tests and browser regression fixtures are offline. Browser fixtures retain actual original IDR metadata/compressed chunks, not generated microscopy. `npm run validate:live` separately checks real remote data against the independent Python reference and may fail on network/CORS changes; see [scientific validation](docs/scientific-validation.md).

An optional segmentation evaluation and bounded DuckDB-Zarr audit are documented separately. Passing an audit of a blocker does not enable the blocked backend.

## Static hosting

```sh
npm run setup:assets
npm run build
npm run preview
```

Publish only `dist/`, never the repository root. For GitHub project Pages, use `BASE_PATH=/musivarium/ npm run build`. The manual **Publish Pages** workflow builds the project-prefix bundle and uploads `dist/`; the maintainer must enable Pages with GitHub Actions and dispatch the workflow after reviewing and pushing changes. Nothing has been published automatically.

The static host must serve WASM with `application/wasm`; remote image hosting must allow CORS from the site's actual origin. No cross-origin-isolation headers or WebGPU are required. Hosted-origin CORS is not guaranteed by localhost testing; verify the deployed URL with `npm run validate:live` after publication. Safari is a best-effort target until separately exercised.

## Development notes

The reader contract is in `src/sources/types.ts`; sampling/measurement/cropping in `src/core.ts`; orchestration in `src/pipeline.ts`; CPU/WASM processing in `src/worker.ts`; render/UI and metadata storage stay separate. Model failures never become threshold results. Unsupported formats and sources are reported explicitly.

The [original plan](plan.md), [implementation status](docs/implementation-status.md), and detailed qualification/audit reports distinguish implemented capabilities from blocked or deployment-only gates. The reference [picture-thousand-records](https://github.com/d33bs/picture-thousand-records) is a useful metadata/UI precedent; this application retains native source arrays rather than treating display JPEGs as raw data.
