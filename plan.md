# IDR Cell Mosaic — MVP Specification

## 1. Summary

Build a single-page, browser-only application that randomly samples image regions from public [IDR OME-NGFF samples](https://idr.github.io/ome-ngff-samples/), extracts individual cells using segmentation masks, and displays their image crops in an interactive mosaic.

The target architecture uses **DuckDB-WASM + a WASM-compatible DuckDB-Zarr extension** for Zarr access and queryable metadata. The DuckDB-Zarr WASM build is an engineering milestone, **not an assumed existing capability**. The application must remain useful while that port is under development by using a browser-side OME-Zarr reader behind the same extraction interface.

**MVP outcome:** Open a static site, select a supported public image, click **Shuffle**, and see a reproducible mosaic of up to 100 real single-cell crops, with source provenance and no application backend.

## 2. Goals

- Run entirely in the browser, hosted on GitHub Pages or equivalent static hosting.
- Read a curated subset of public IDR OME-NGFF datasets via HTTP range/chunk requests where supported.
- Randomly sample image regions using a deterministic seed.
- Use existing instance-label images where available; add model-based segmentation after the mosaic works.
- Display cropped single-cell images in a responsive, paginated mosaic.
- Preserve source, image, region, object, channel, and segmentation provenance.
- Export mosaic metadata as CSV or Parquet; optionally export crops as a ZIP.
- Keep the image reader and segmentation engine replaceable.

## 3. Non-goals for the MVP

- Full CellProfiler or `cp_measure` feature parity.
- Whole-slide or whole-dataset segmentation.
- Server-side inference or processing.
- Support for every OME-NGFF version, codec, axis order, or label convention.
- Large-model inference on every browser/device.
- Production-grade scientific segmentation accuracy without validation.

## 4. User experience

### Main page

- **Dataset selector:** Curated IDR sample list with image dimensions, channels, label availability, and supported status.
- **Sampling controls:** Seed, number of cells (default 100), region size (default 512 × 512), and Shuffle button.
- **Segmentation selector:** `Existing labels` initially; later `Model` and `Classical` options.
- **Channel controls:** Channel visibility and display contrast.
- **Mosaic:** Responsive grid of fixed-size cell crops, with optional mask outlines and loading placeholders.
- **Cell details:** Clicking a tile shows source image, region coordinates, object ID, bounding box, mask, and source URL.
- **Export/share:** Copy reproducible URL, download metadata, and optionally export crops.
- **Progress:** Show fetched regions, segmented objects, accepted cells, and failures.

### Shuffle behavior

1. Use a supplied seed or generate a new one.
2. Select an image from the curated supported set, or honor a pinned image.
3. Sample valid spatial regions at the chosen resolution.
4. Retrieve pixels and instance labels (or run segmentation when enabled).
5. Reject incomplete objects touching region edges and objects outside configurable size/quality thresholds.
6. Randomly choose accepted objects and extract crops centered on each object.
7. Repeat with additional regions until the requested count is reached or a configurable work limit is hit.
8. Display the result incrementally; report if fewer cells were found.

**Important:** Uniform random sampling of regions does not imply uniform random sampling of all cells in a dataset. Document the sampling method; avoid claiming statistical representativeness.

## 5. Architecture

```text
IDR OME-NGFF catalog / curated manifest
                |
        Dataset metadata
                |
    Seeded region sampler
                |
       Image access adapter
         /             \
DuckDB-Zarr WASM    Browser Zarr reader
  (target)           (fallback)
         \             /
        Pixel and label arrays
                |
       Segmentation adapter
       /               \
 Existing labels     Model inference
   (MVP)             (later)
         \             /
       Object filtering/cropping
                |
       Mosaic + cell inspector
                |
       DuckDB-WASM metadata
                |
        CSV / Parquet export
```

### 5.1 Data source and manifest

Create a checked-in manifest of 1–3 verified, browser-accessible IDR OME-NGFF samples. Each entry should include:

- Stable dataset/image ID and URL.
- NGFF/Zarr version and supported codec information.
- Axis order, image shape, multiscale levels, and channel names.
- Whether compatible instance labels exist and their URL/path.
- Coordinate transforms linking labels to pixels.
- CORS/browser accessibility test result.
- Default display channels and representative crop dimensions.

**Do not assume every sample in the IDR catalog has segmentation labels or compatible browser access.** Validate each entry before adding it.

### 5.2 Zarr extraction

Define a TypeScript interface independent of the implementation:

```ts
interface ImageRegion {
  imageId: string;
  level: number;
  x: number;
  y: number;
  width: number;
  height: number;
  channels: number[];
  pixels: ArrayBufferView[];
  labels?: Uint32Array;
}

interface ImageSource {
  getMetadata(imageId: string): Promise<ImageMetadata>;
  readRegion(request: RegionRequest): Promise<ImageRegion>;
}
```

Implementations:

- `BrowserZarrSource`: fallback reader for the selected NGFF version/codecs.
- `DuckDBZarrSource`: target integration using DuckDB-WASM and the compiled extension.

DuckDB-Zarr should push down spatial region selection to avoid reading entire arrays. Decode only required chunks, then trim to the requested window. Cache recently used chunks. Avoid materializing every pixel as an individual SQL row if a binary/array transfer is faster.

### 5.3 WASM port milestone

Before depending on DuckDB-Zarr in the main application:

1. Audit native dependencies, filesystem assumptions, codecs, and DuckDB extension APIs for Emscripten/WASM compatibility.
2. Build and load a minimal DuckDB-Zarr WASM extension in DuckDB-WASM.
3. Read metadata and a small region from a public browser-accessible Zarr store.
4. Verify CORS, memory use, transfer size, chunk reads, and data correctness against a native reference.
5. Expose a stable `readRegion` API through the image source adapter.

**Acceptance gate:** The extension reads a real supported IDR image region in a mainstream browser without a custom server. If this is blocked, ship the MVP with `BrowserZarrSource` and continue the port separately.

## 6. Segmentation strategy

### Phase A: Existing labels

Start with a dataset containing instance labels that identify individual objects. Align labels with image coordinates using NGFF metadata. This proves random sampling, cropping, mosaic rendering, and provenance without inference.

### Phase B: Automated segmentation

Add a replaceable segmentation adapter:

```ts
interface SegmentationEngine {
  name: string;
  version: string;
  segment(region: ImageRegion): Promise<Uint32Array>;
}
```

Candidate backends:

- **cellpose-js / ONNX Runtime Web:** Candidate for pretrained single-cell segmentation; evaluate model compatibility, WebGPU requirements, model download size, and quality on the selected images.
- **OpenCV.js or ITK-Wasm:** Classical thresholding, morphology, and watershed baseline.

Do not declare any model the fastest or most accurate without benchmarking it on the selected image types. Provide a CPU/WASM-capable fallback if the preferred inference engine requires WebGPU.

### Object selection

- Treat each nonzero label as a candidate instance.
- Compute bounding box, centroid, area, and boundary-contact flag.
- Reject clipped objects and implausibly small/large instances using configurable thresholds.
- Apply crop padding; do not resize in a way that hides scale differences without recording the transformation.
- Preserve the original pixel data and label mask; use rendered RGB composites only for display.
- Deduplicate objects sampled in overlapping regions using stable image/label IDs or spatial matching.

## 7. Mosaic and cell inspection

- Render the first accepted cells as soon as available.
- Virtualize or paginate larger grids to avoid excessive DOM/canvas memory.
- Use consistent crop dimensions and channel color mapping.
- Provide toggles for segmentation outline and background context.
- Show source image, pixel coordinates, segmentation method/version, crop size, and channels for every cell.
- Support clicking a cell to inspect its original region and mask.
- Display failures and unsupported datasets clearly rather than silently omitting them.

## 8. Data model and exports

Store a row per displayed object in DuckDB-WASM:

| Column | Meaning |
|---|---|
| `sample_id` | Curated dataset ID |
| `image_url` | Source image URI |
| `seed` | Reproducible sampling seed |
| `region_x`, `region_y` | Region origin in pixel coordinates |
| `level` | Multiscale level |
| `object_id` | Instance label ID, scoped to source/region |
| `centroid_x`, `centroid_y` | Object centroid in image coordinates |
| `bbox_x`, `bbox_y`, `bbox_width`, `bbox_height` | Object bounding box |
| `area_pixels` | Pixel area |
| `segmentation_engine`, `segmentation_version` | Provenance |
| `channels` | Channels used for display/segmentation |

Add minimal measurements only after the end-to-end mosaic works: area, centroid, bounding box, and per-channel mean intensity. Export metadata to Parquet and CSV. Optional ZIP export can include PNG crops and a manifest.

## 9. Reproducibility

Encode in the shareable URL:

- Dataset/image ID and manifest version.
- Random seed and sampling algorithm version.
- Region size, scale level, requested count, and filtering thresholds.
- Segmentation engine/model version and parameters.
- Channel/display settings.

A seed alone is insufficient for exact reproduction if dataset ordering, model weights, or filtering rules change. Prefer deterministic ordering and pinned versions. Where GPU inference is nondeterministic, document the limitation and allow saved object manifests.

## 10. Performance and resource limits

- Default region size: **512 × 512** pixels; make configurable.
- Default target: **100 cells**; show partial results rather than blocking until complete.
- Fetch only needed chunks and channels.
- Cache Zarr metadata and recent chunks in memory.
- Use Web Workers for decoding, segmentation, and feature calculation.
- Limit concurrent requests and segmentation jobs to avoid memory spikes.
- Allow cancellation of an in-progress Shuffle operation.
- Record fetch time, decode time, segmentation time, accepted cells/region, memory estimates, and bytes transferred.
- Establish device-specific performance targets after the first baseline; do not assume a fixed runtime across browsers.

## 11. Testing and validation

### Functional

- Supported image metadata parses correctly.
- Region coordinates map to correct pixels and channels.
- Existing label masks align with source images.
- A fixed seed reproduces region choices and cell ordering.
- Crops contain the selected object and retain source provenance.
- Failed network requests and unsupported codecs show actionable errors.
- Exports can be reloaded and match displayed metadata.

### Scientific correctness

- Compare extracted regions against a Python Zarr reference.
- Compare existing-label object area, centroid, and bounding box against a trusted Python reference.
- For model segmentation, evaluate precision/recall or instance-level matching on annotated examples, plus runtime and memory.
- Test border objects, overlapping sampling regions, missing channels, different axis orders, and non-square pixels.

### Browser compatibility

Test at least current Chrome and Firefox, and Safari if feasible. Feature-detect WebGPU rather than assuming it exists. Verify CORS from the deployed static site.

## 12. Milestones

### M0 — Dataset qualification

- Curate and verify 1–3 public OME-NGFF images.
- Confirm at least one has usable instance labels.
- Record supported NGFF version, codecs, axis order, CORS, and coordinate transforms.

**Done when:** A browser can retrieve a test region and matching labels.

### M1 — Browser mosaic

- Implement seeded region sampling, existing-label extraction, object filtering, crops, mosaic UI, and cell inspector.
- Use `BrowserZarrSource` if DuckDB-Zarr WASM is not ready.

**Done when:** A static site displays up to 100 real cells and can reproduce a mosaic from a shared URL.

### M2 — DuckDB-Zarr WASM

- Port/build the extension, add `DuckDBZarrSource`, and compare outputs with the fallback.
- Measure bytes transferred, time, and memory.

**Done when:** The same sample and seed yield equivalent crops through DuckDB-Zarr WASM.

### M3 — Automated segmentation

- Integrate one model-based backend and one classical baseline.
- Benchmark speed, memory, and segmentation quality on selected images.

**Done when:** Users can generate a mosaic from an image without preexisting labels.

### M4 — Queryable results and exports

- Add DuckDB-WASM object table, basic measurements, CSV/Parquet exports, and optional crop ZIP.

**Done when:** The exported rows map back to every displayed object.

## 13. Recommended project structure

```text
src/
  app/             # UI and state
  catalog/         # curated dataset manifest and validation
  sampling/        # deterministic region and object selection
  sources/         # BrowserZarrSource and DuckDBZarrSource
  segmentation/    # existing labels, classical, model backends
  objects/         # filtering, deduplication, cropping
  mosaic/          # grid, inspector, display channels
  storage/         # DuckDB metadata and exports
  workers/         # image decoding and inference
  types/           # shared interfaces
public/
  datasets.json
  models/           # optional, only if license and size permit
scripts/
  verify-datasets.*
tests/
  fixtures/
  integration/
  scientific/
```

## 14. Key risks and mitigations

| Risk | Mitigation |
|---|---|
| DuckDB-Zarr cannot yet load in DuckDB-WASM | Keep a browser Zarr reader behind the same interface; make the port an independent milestone |
| IDR sample URLs fail CORS or use unsupported codecs | Verify and pin a small compatible manifest before building the UI |
| Existing labels do not correspond to desired cells | Inspect samples and validate object identity and coordinate alignment |
| Model inference is slow or requires WebGPU | Ship label-based mosaic first; benchmark model and classical backends |
| Random regions contain few valid cells | Use bounded retries, incremental rendering, and report actual count |
| Very large images exhaust browser memory | Chunk-aware reads, small regions, workers, cancellation, and bounded caches |
| Results are not exactly reproducible | Pin versions and parameters; save a manifest of selected objects |

## 15. Definition of done

The MVP is complete when a user can visit a static URL, select a verified IDR OME-NGFF image, click **Shuffle**, see a mosaic of real segmented objects, inspect any object's source coordinates and mask, reproduce the selection using a shareable URL, and export object metadata, without an application backend.

**Architectural target:** DuckDB-Zarr WASM performs image extraction. **Delivery fallback:** a browser OME-Zarr reader allows the mosaic MVP to ship independently of the extension port.

