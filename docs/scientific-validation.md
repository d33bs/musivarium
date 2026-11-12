# Scientific correctness validation

## What is independently checked

The checked-in fixture is a **real, unaltered 64 × 64 native-pixel region** of
**IDR0076 / image 10501752**, finest image channel **42, DNA1-191Ir**, and its
aligned existing cell-instance labels:

```text
Image group:
https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/
Image array: 0
Label group: labels/0
Label array: labels/0/0
Selection: image[42, 224:288, 160:224], labels[0, 224:288, 160:224]
```

This is a **2D single-plane sample, not a projection**: the source axes are
`c,y,x`; there is no real Z or T axis. `z=0,t=0` in the request is an API
convention. No interpolation, intensity normalization, inference, RGB rendering,
relabeling, or downsampling was used. Channel 42 is an application display
selection, not the metadata-active channel default.

The ROI crosses the finest label array's **y=247 chunk boundary**, requiring
both label chunks. Image and label level-0 scales are `[1,1,1]`, translations
`[0,0,0]`. Physical spatial units are not declared; all reported measurements
here are native pixels, not µm or 3D cell sizes. Study/importer provenance and
the distinction between image-local instance IDs and biological classes are in
`dataset-qualification.md`.

## Fixture, pinning, and attribution

`tests/fixtures/idr0076-10501752/` contains:

| File              | Meaning                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `image-c42.f64le` | 32,768 bytes: 64 × 64 little-endian Float64, row-major                                                                             |
| `labels.i16le`    | 8,192 bytes: aligned native little-endian signed Int16 labels, background zero                                                     |
| `expected.json`   | Independent measurements for **all 25 objects**, plus **100 crop/mask byte references**                                            |
| `manifest.json`   | Exact selection, native dtypes, source URLs, compressed-response byte lengths/SHA-256, decoded ROI hashes, license and attribution |
| `README.md`       | Redistribution notice and quick decoding instructions                                                                              |

The manifest content-pins **11 original HTTP response bodies**, including group
and array metadata, the native c42 compressed image chunk, both compressed label
chunks, and commit-pinned study/importer provenance. Mutable remote URLs are not
assumed immutable: a changed hash fails native live validation. Compressed-source
hashes and decoded/cropped fixture hashes are intentionally different contracts.

Decoded, cropped, little-endian C-order byte SHA-256:

| Native plane             | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| Float64 c42 ROI          | `7a5ea59c974ffb6bd7b0f3fb730c72079e40cb843b4545fd5b35cc001c0655b0` |
| Int16 instance-label ROI | `bdcdeb5694767bc44c355c57ed26b2faf3818752628e91f46093d1afd2cdc5d2` |

**Data license: CC BY 4.0; copyright Ali et al.** Attribution: Ali et al.,
_Imaging mass cytometry and multiplatform genomics define the phenogenomic
landscape of breast cancer_ (2020), IDR0076 / image 10501752, distributed by IDR.
Publication DOI: `10.1038/s43018-020-0026-6`; data DOI: `10.17867/10000146`.
Only a cropped native region is redistributed; fixture packaging and independent
measurements were added. The commit-pinned `idr0076-study.txt` in the manifest
specifies the authors, license URL, copyright and data DOI. Preserve attribution
and the CC BY 4.0 notice when redistributing these fixture pixels and labels.

## Independent Python oracle

`scripts/validate-reference.py` does **not** import or translate the TypeScript
implementation. It uses:

- Python Zarr **2.18.4** and Numcodecs **0.15.0** for original source decoding;
- scikit-image **0.26.0** `measure.regionprops` for area, exclusive bbox,
  geometric centroid and native per-object mean intensity;
- SciPy **1.17.1** `ndimage.sum_labels`, `center_of_mass`, and `mean` as an
  independent cross-check of the scikit-image measurements;
- NumPy **2.4.6** for native-byte slicing and target-label masks.

All 25 nonzero IDs are retained in the oracle, including clipped instances:
**1,000 foreground pixels, 14 interior objects, 11 ROI-edge objects**. Edge means
contact with any of the four ROI borders. A boundary object's area is its area
_within this ROI_, not a claim that its complete original object is visible.
Equal IDs remain one instance even if a label has disconnected pieces.

Coordinates are global zero-based pixel indices. Python `(row,column)` centroids
are explicitly converted to `(x,y)` and offset by `(160,224)`; no half-pixel
shift is introduced. Bbox maxima are exclusive; width/height are differences.
Area, bbox, IDs and edge flags must match exactly. Centroids and means have
absolute tolerance `1e-11`, zero relative tolerance in the Python/live comparisons.
The JSON stores the actual Float64 reference values, not rounded report values.

For **each object**, independent crop references cover padding 0 and 8, each
with minimum side 0 and 32. Crops are square and centered on the **bounding box**,
not the geometric centroid. Top/left round down, permitting at most a half-pixel
center displacement; the requested square is clipped at ROI borders rather than
resized or shifted. The hashes cover original Float64 crop bytes, the binary
`labels == selected_id` mask, and Float64 target-isolated intensities. Neighbor
instances inside a rectangular crop are not accidentally counted as target
pixels. The full target area must remain represented in every crop.

## Offline checks

From the repository root:

```sh
npm test -- tests/scientific.test.ts
uv run scripts/validate-reference.py
```

`uv` uses the script's pinned inline Python dependencies. Its first run may need
package downloads; fixture and reference checks themselves make no source-data
requests. With dependencies already cached, `uv run --offline
scripts/validate-reference.py` also works.

The TypeScript suite compares the **production `extractObjects`** results against
all Python reference objects, verifies byte hashes and input immutability, checks
global coordinate offsets, and exercises production `cropObject` against all 100
independent crop cases. It also runs the **existing-label `runPipeline`** using an
explicitly offline ROI adapter. That check excludes the 11 boundary objects and
compares all 14 accepted cells' native means, coordinates, target masks and crops.
The adapter declares local ROI coordinates plus the true `(160,224)` translation;
it is not passed off as a live full-image reader. Neither model inference nor
DuckDB/SQL is part of the independent scientific oracle.

## Rebuilding, explicitly

Original qualification evidence can rebuild the compact fixture without network
access:

```sh
uv run scripts/validate-reference.py --rebuild \
  --qualification-cache /path/to/musivarium-qualification
```

The directory must contain `requests-index.json`, original response bodies,
`label-source-c42.npy`, and `instance-label-plane.npy`. Every source body is
validated against its manifest pin. Native Python Zarr decoding must match both
original full-resolution `.npy` planes **before** the 64 × 64 slice is written.
The script then regenerates `expected.json` through SciPy/scikit-image and reads
it back for verification. It never silently refreshes the source hash pins.

Alternatively, `--rebuild --live` fetches the same hash-pinned native sources
without depending on qualification scratch files.

## Opt-in real browser and native live parity

Leave an existing Vite dev server running; the validation script neither starts
nor kills it. To start one separately when needed:

```sh
npm run dev -- --port 5184 --strictPort
```

Then run:

```sh
node scripts/validate-live.mjs --url http://127.0.0.1:5184 \
  --report /path/to/browser-live-report.json
uv run scripts/validate-reference.py --live \
  --report /path/to/native-live-report.json
```

The Playwright script launches real headless Chromium, establishes the local
Vite origin by navigating to its served source-module document, and dynamically
imports **`/src/sources/browser.ts`**. This avoids application UI/HMR reloads while
still exercising the actual browser reader, browser codec execution, and real
cross-origin HTTP source requests. It does not substitute fixture responses,
proxy remote arrays, decode with Node, or intercept routes. Fixtures supply only
expected checksums and object measurements. It validates alignment, exact native
`Float64Array`/`Int16Array` dtypes, both decoded ROI checksums and all 25 objects'
area, bbox, centroid, mean and boundary flags.

The JSON report includes exact source/module URLs, origin, browser version,
expected and actual hashes, comparisons, per-source request/byte/status records,
and failed requests. Failed attempts remain recorded even if the bounded retry
succeeds. Default is two attempts, selectable with `--attempts 1` through `3`.
`--browser firefox` or `--browser webkit` selects another installed Playwright
engine; no cross-browser pass is implied without running it. Browser packages
must be installed (for example `npx playwright install chromium`).

Native `--live` separately fetches all 11 pinned original bodies with bounded
streaming, a 16 MiB response guard, connect/read timeouts and at most three
attempts per response. It decodes the actual compressed arrays with Python Zarr
and compares all measurements/crops to the same oracle. **Unavailable real data
or a changed source hash is an error, never an invitation to fall back to a
fixture and report a live pass.** Normal reader probes for optional array
`.zattrs` may return 404; those are recorded and are not failures of the required
source arrays.

## Executed evidence

On **2026-11-12 UTC**, from the existing Vite server at
`http://127.0.0.1:5184`:

- Five scientific Vitest tests passed; TypeScript typecheck passed.
- Offline Python and qualification-cache reconstruction passed all 25 objects
  and 100 crop references.
- Native Python live source hash verification and decoding passed.
- Real Chromium **158.0.8127.18** passed both native ROI hashes and all 25
  measurements; maximum centroid and native-mean absolute errors were **zero**.
- The successful browser run fetched the actual c42 image chunk and **both label
  chunks**. Optional array metadata 404s were retained in its report.

Local machine-readable reports from that run are in qualification scratch as
`app-scientific-live.json` and `app-native-reference-live.json`; these may be
pruned, so the checked-in manifest/oracle and runnable commands are authoritative
for reproduction, not availability of scratch files.

An initial native probe encountered a truncated HTTP body. Bounded Requests
streaming replaced the short-read-prone probe and the hash-pinned live run then
passed. Initial UI-page navigation also encountered Vite reloads during active
development; navigating directly to the served module removed UI/HMR dependence.
No source hash, fixture byte or expected measurement was changed to make either
live check pass.

## Limits of the claim

This validates one real level-0 ROI of an existing-label 2D source and the
measurement/crop path, not instance-segmentation accuracy, biological phenotype
identity, arbitrary axes/codecs, 3D geometry, sampling representativeness,
DuckDB-Zarr parity, UI display accuracy, or every source channel. The IDR0033
image does not gain existing labels from this fixture. No model-accuracy or
whole-cell inference claim follows from a correct measurement of a supplied
instance mask.
