# Implementation status

The browser MVP and automated segmentation/export work are implemented. DuckDB-Zarr now reads image and label pixels through complete, bounded single-chunk in-memory views of original compressed source payloads. Zarrita is dev-only and is not a production fallback. This integration has not been committed, pushed or published.

## Acceptance gates

| Plan milestone                     | Actual result                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 — dataset qualification         | Complete: two real IDR images qualified, including a source with aligned cell-instance labels                                                                                                                                                                                                 | `public/datasets.json`, `docs/dataset-qualification.md`; original-byte and Python/browser checks                                                                         |
| M1 — browser mosaic                | Complete locally: 100 objects, incremental worker batches, deterministic partition/object sampling, virtualized crops, inspector, display controls and reproducible URLs                                                                                                                      | `tests/browser/workflow.spec.ts`; Chromium and Firefox integration tests; root/project-prefix production smoke                                                           |
| M2 — DuckDB-Zarr extraction        | Implemented using the official community extension: bounded original-chunk downloads, complete decoder views, real SQL extraction, unchanged native values and source coordinates. Direct whole-store positional bounds remain unsupported upstream; they are not the production access path. | `docs/duckdb-zarr.md`, `tests/browser/duckdb-reader.spec.ts`, `tests/browser/duckdb-failure.spec.ts`; actual native-byte hashes, chunk keys, SQL and memory-file cleanup |
| M3 — automated segmentation        | Complete: real pinned StarDist ONNX CPU/WASM inference plus Otsu/components baseline; no disguised fallback                                                                                                                                                                                   | `docs/segmentation.md`, `docs/segmentation-evaluation.md`; actual model execution in Chromium/Firefox production workers                                                 |
| M4 — queryable results and exports | Complete: local DuckDB object table; filtered CSV/Parquet export/readback; native NumPy crop/label ZIP and PNG previews. The SQL editor has been removed from the demo UI.                                                                                                                    | `tests/browser/workflow.spec.ts`; self-hosted pinned Parquet extensions, no external software requests                                                                   |
| Public deployment                  | Prepared, not published: static bundle and manual GitHub Pages workflow; repository Pages configuration and publication require maintainer action                                                                                                                                             | `.github/workflows/pages.yml`; actual static root and `/musivarium/` checks, not an assertion about hosted-origin CORS                                                   |

The supplied NGFF 0.5 Cell Painting source is already 2D (`c,y,x`), so its only valid Z/time index is zero. It has no advertised masks. It is retained as the model/classical preset and has been exercised through the actual model pipeline; a bounded tile can legitimately return fewer objects than requested. The initial existing-label workflow instead uses the separately qualified IDR0076 image. Neither preset loads a volume or produces a projection.

## Automatic opening and focused layout

The page automatically samples its default image or a valid shared URL. Choosing a supported preset starts a fresh load; manual control edits still use Sample objects. Settings start collapsed on desktop and mobile. Show settings/Hide settings and an in-panel Hide button provide keyboard-accessible access without reloading the mosaic. Shuffle, Cancel and sharing remain outside the panel, and source attribution stays visible. Invalid URL state does not silently trigger a default-data load.

## Final verification

Executed against the working tree:

- `npm run check`: TypeScript, **54 unit/scientific tests passed**, one optional model benchmark skipped by the default runner, and production Vite build passed.
- The optional benchmark was separately enabled with `SEGMENTATION_BENCHMARK_DIR`: **9/9 segmentation tests passed**, including actual graph inference, model integrity and corrupt-weight rejection.
- `npm run test:browser`: **52/52 Chromium/Firefox tests passed**, including original IDR compressed bytes, 100-object selection, repeatable URLs, mouse/keyboard inspector, rendering controls, virtualization, cancellation/error recovery, real DuckDB-Zarr SQL image/label reads and native export readback. This also includes a real-WASM overlapping-table-load regression and a grayscale/green-outline pixel check.
- `npm run test:static`: **four production cases passed** — Chromium and Firefox at both `/` and `/musivarium/`. Each generated 100 existing-label objects, a 22,590-byte Parquet file, and a separate three-object real StarDist result, with zero JavaScript errors or unexpected external requests. Test input pixels were exact original IDR snapshots; these cases are not labelled live network tests.
- `npm run validate:reference`: **25 real objects and 100 crop/mask references** matched independent SciPy/scikit-image measurements, including boundary objects and native Float64 means.
- The production preview at `http://127.0.0.1:5185/` also completed a real, non-intercepted 100-object IDR run and initialized its local SQL table without browser errors; it remains available for local review.
- Real remote checks separately passed in **Chromium, Firefox and native Python**: native image/label ROI hashes matched, with zero centroid/mean error across all 25 instances. The live scripts do not intercept requests or substitute offline data.
- The single-image instance benchmark reproduced **49 TP / 6 FP / 16 FN**, precision **0.890909**, recall **0.753846**, F1 **0.816667** for the model at IoU ≥ 0.5. Classical yielded **45 / 7 / 20**, F1 **0.769231**. This is a pinned 256² annotated smoke example, not held-out evaluation or a claim of universal superiority.
- A clean scratch checkout with no `node_modules`, model weights, or vendor binaries passed `npm ci`, checksum-verified `npm run setup:assets`, TypeScript, unit/scientific checks, and the production build.
- `npm run format:check`, `npm audit --audit-level=moderate`, `actionlint` and offline `zizmor` passed. No remote CI execution is claimed.

Machine-readable static/live/benchmark evidence is in the local scratch directories `musivarium-static-validation`, `musivarium-validation`, and `musivarium-segmentation-evaluation-final`; scratch may be pruned. The checked-in fixtures, hash pins, independent oracle and repeatable scripts are the durable reproduction inputs.

## Grayscale display with green focus outlines

Crops and the inspector previously composited each channel through its source metadata color (e.g. DNA1-191Ir mapped to red), which read as a colorized/red image rather than a scientific grayscale view. Display compositing now ignores per-channel metadata colors and renders every selected channel in white/grayscale; the channel legend keeps a white swatch and exposes the original metadata color only as a title tooltip, so source color metadata is preserved in exports/manifests but never drives pixel rendering. The focus outline changed from yellow (`#F1D987`) to green (`#00FF00`) and is enabled by default (`DEFAULT_VIEW.overlay = true`); it still targets only the inspected/focused instance ID, never neighboring labels. `provenance()` now records `display_palette: 'grayscale'` and `segmentation_outline_color: '#00FF00'` without altering `metadata.channels[].color`. Verified with unit tests (`composite`/`outline`), a live-pixel Chromium/Firefox Playwright test (`tests/browser/grayscale.spec.ts`) using the real IDR0076 fixture, and a non-intercepted production-preview run against the live source showing zero non-gray/non-green pixels.

## Minimal completed view

The completed view omits the decorative mosaic heading, numbered Explore label and success-state helper sentence. Progress is shown only while work is running; actionable errors remain visible. Tests use export readiness rather than depending on success-message wording.

## Streamed progress and bounded parallel reads

The reading panel now updates while response bodies stream, including elapsed time, received bytes, known discovered sizes, request counts and retries. Missing/HTTP-decoded Content-Length is treated as unknown. Image and label metadata, selected image channels, and aligned label reads overlap under a shared four-request semaphore and 64 MiB decoded-chunk reservation. Label alignment is verified before mask extraction, segmentation remains sequential, and cancellation removes queued work. Only the currently needed region is read.

Focus outlines default to on and select the current instance ID, not neighboring labels. An explicit saved display setting can still disable them.

A three-repeat alternating original-byte replay with 80 ms/request controlled latency measured median pipeline times of 883.4 ms before and 466.5 ms after, with identical 100-object native crop/mask/measurement SHA-256, the same 11 source objects and 1,674,611 response bytes. This is a latency-controlled transport experiment, not a WAN speed forecast. See `docs/reading-performance.md`.

## Review fixes

Independent review found no confirmed security or data-fidelity blocker. The confirmed timing bug — successful HTTP attempts missing their start timestamp — is fixed. A regression now decodes actual original compressed IDR bytes behind a delayed transport and checks that successful download time is subtracted from `decode_copy_ms`.

Parent-side integration also reproduced and fixed external JSON/Parquet autoload dependencies, overlapping DuckDB table writes, and stale asynchronous query/export updates. Metadata now enters through Arrow, Parquet is self-hosted and hash-pinned, table loads are serialized, and stale run/query results are discarded.

## Interpretation and remaining limits

- Objects from supplied tissue masks are 2D cell sections. StarDist outputs nuclei, not whole-cell boundaries.
- Partition sampling and seeded object selection are not statistically representative cell sampling.
- Unknown axis mappings, codecs, label alignment, and chunks spanning multiple Z/time indices are rejected rather than silently reinterpreted.
- Display percentile/fixed-window contrast never replaces native measurement values. Rendered crops preserve source pixel aspect, with actual native crop geometry exported.
- `fetch_ms` sums original-source request durations, including overlap; `decode_copy_ms` now includes the DuckDB chunk-view transaction: first-use runtime/extension startup, registration, SQL decoding and native reconstruction. It is not an isolated codec microbenchmark. Logical decoded/crop/array byte estimates are not peak browser RSS.
- Public hosted-origin CORS, Safari, and the GitHub Actions Linux runner have not been verified in this local session.
- Direct whole-store positional bounds still require upstream work. The enabled reader uses complete one-chunk decoder views instead; it never registers a sparse original-size volume or treats absent chunks as fill values. Unsupported codecs/sharding fail explicitly.
