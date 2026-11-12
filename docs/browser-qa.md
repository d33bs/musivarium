# Browser workflow qualification

## Scope and attribution

These are **offline browser integration tests**, not a claim that IDR or a live
network is currently reachable. `tests/browser/fixtures/idr0076/manifest.json`
pins 12 observed HTTP responses to 11 deduplicated bodies (1,674,624 bytes).
Every fixture is the original captured HTTP entity body, including the original
Blosc/LZ4 compressed image and label chunks. Metadata, array shapes, transforms,
codecs and dtypes have not been rewritten. No synthetic microscopy is used.

Data attribution: **IDR0076, Ali et al., image 10501752, CC BY 4.0**, served by
IDR / EMBL-EBI. Exact original URLs, capture timestamps, SHA-256 hashes, byte
lengths and license URL are recorded in the fixture manifest. Source image data
is channel 42 (DNA1-191Ir); supplied instance labels are `labels/0`. The image
has axes `(c, y, x)`, shape `(50, 494, 464)`, native `float64` intensities and
signed-int16 source labels. Only one channel and one 2D plane are read. No Z
volume, projection, artificial metadata axis, or substituted image is involved.

The only deliberately fabricated responses are explicitly named negative tests:
a 404 transport failure and unsupported `banana` axis metadata. Original bytes
are restored before recovery is asserted.

## Run and verify

```sh
node scripts/setup-browser-fixtures.mjs
npm run test:browser -- tests/browser/workflow.spec.ts --project=chromium --workers=1
npm run test:browser -- tests/browser/workflow.spec.ts --project=firefox --workers=1
```

The Playwright config starts its own Vite server on port 5183. Tests disable
Vite's development-only WebSocket hot reload to avoid concurrent file edits
replacing the document mid-assertion. They block service workers, external
network dependencies, and unknown source URLs. Browser-context routing intercepts
fetches from the actual pipeline Web Worker. The application uses system fallback fonts without external font requests. The fixture helper also blocks legacy Google stylesheet requests for isolation. DuckDB extension requests are blocked and
recorded separately rather than silently passed through to the internet.

The setup script verifies all pinned bytes without internet by default. Explicit
`--download` redownloads originals and refuses changed status/hash/length; it does
not refresh pins or manufacture responses. `npm run setup:assets` is separately
required for local DuckDB and model assets. Fixture bodies remain in tests, not
in public application assets.

## Acceptance checks

- Initial page and valid shared URLs automatically sample; supported preset changes reload without a second click. Settings begin collapsed, can be opened/closed on desktop/mobile without image downloads, and expose cancellation while loading.
- Explicit metadata inspection adds no chunk requests; default sampling collects 100 unique
  objects on channel 42, one 512-pixel bounded XY tile (actual 464 × 494 extent).
- Real worker decode, label segmentation, native measurements, source provenance.
- Mouse and Enter inspector opening; explicit level/time/Z fields.
- Outline, context, fixed contrast, area/intensity filters, sorting, keyboard
  movement and scroll virtualization without additional source requests.
- Reopening an exact sampling URL reproduces all exported object rows; shuffle
  changes the seed and selected IDs.
- Cancellation while the original compressed image response is gated publishes
  no partial result, disables exports, then allows a successful fresh sample.
- Unavailable source and unsupported metadata errors recover to original bytes.
- Native ZIP and PNG signatures; manifest/cell file cardinality; independent
  NumPy header parsing checks `<f8` intensity and `<u4` exported label dtypes,
  shapes and payload lengths. For every exported object, the mask recount and
  mean recomputed from the original exported pixels match object measurements.
- SQL aggregate/filter queries and invalid SQL recovery; CSV and Parquet exports
  are reread through actual DuckDB, including visible-filter intersection.

## Verified result and resolved findings

Final full-suite execution passed **6/6 tests on Chromium (9.8 seconds)** and
**6/6 on Firefox (9.3 seconds)**. This includes real SQL aggregates, invalid SQL
recovery, CSV readback, Parquet signatures/readback, visible-filter intersection,
and native ZIP/NPY measurements. The SQL test also asserts no external DuckDB
extension request was attempted.

Initial execution exposed a real offline SQL dependency: `read_json_auto`
autoloaded the JSON extension, causing Chromium to report `table index is out
of bounds` and Firefox to report an unavailable external JSON extension. After
the application switched to native Arrow insertion, Firefox progressed through
SQL and CSV readback but exposed a second external autoload for Parquet. The
parent implementation then self-hosted the checksummed Parquet extension and
configured a same-origin extension repository with explicit loading. Both
browsers subsequently passed the complete workflow; no SQL responses were
mocked. These application fixes were outside this test agent's owned files.

A first native-export run was disrupted by Vite hot reloads from concurrent repo
edits; blocking the development WebSocket removed that interference. Tests use
bounded download waits and report the application status on export failure.
These checks do not qualify production-prefix hosting, pretrained-model results,
new IDR availability, or microscopy channels/levels not present in this snapshot.
