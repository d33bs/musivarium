# DuckDB-Zarr: audited, unavailable for bounded OME image reads

**Decision:** do not enable DuckDB-Zarr as an image backend. The extension can
load and execute real Zarr SQL in Chromium, but the tested artifact does not
meet this application's bounded, single-Z-plane crop requirement for ordinary
OME-NGFF arrays without stored coordinate arrays. Use `BrowserSource` (Zarrita)
for pixels and the existing DuckDB runtime for metadata. No extension binary or
production-support manifest is placed in `public/duckdb-zarr/`.

## Actual browser result

Audit executed on November 11, 2026, with Chromium from
`@playwright/test@1.65.0`. This is an actual DuckDB-WASM data-reading query over
HTTP-served Zarr bytes, not a mocked SQL response. The fixture is explicitly
synthetic: shape `[c,z,y,x]=[2,3,4,4]`, chunks `[1,1,2,2]`, uint16,
uncompressed, OME-NGFF 0.4 axes. Each pixel is `1000*c + 100*z + 10*y + x`.
Only this tiny format fixture was scanned; no biological volume was downloaded.

| Check                                            | Observed result                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Pinned extension load using its tested runtime   | Success                                                                                                                         |
| `SELECT version()` in tested runtime             | `v2.0.0-dev88614`                                                                                                               |
| Four-pixel crop, `c=0,z=1,y=1..2,x=1..2`         | `[111,112,121,122]`                                                                                                             |
| Unique data chunks fetched for that crop         | **24 of 24**                                                                                                                    |
| Chunks fetched from other Z planes               | **16**                                                                                                                          |
| Explicit `bounds :=` on the same image           | Binder error: `bounds: dimension 'z' has no coordinate array to compare against`                                                |
| Existing app package `1.33.1-dev57.0`, EH engine | Reports `v1.5.4`; extension initialization fails: `Unsupported C CAPI version detected during extension initialization: v1.5.6` |

The correct four output pixels do **not** demonstrate bounded I/O. In this
artifact, ordinary SQL `WHERE` filters the rows after the image scan rather
than pruning the original image chunks. Its separate `bounds` argument prunes
using stored coordinate arrays, which this ordinary OME image does not contain.
The source at the artifact's exact commit confirms the distinction in
`src/read_zarr.rs`: `finish_bind` obtains each bounded axis from `coord_arrays`
and rejects absent coordinates before constructing the chunk work units.

Executed query (the audit substitutes its local HTTP origin):

```sql
SELECT c,z,y,x,value
FROM read_zarr('http://127.0.0.1:5198/synthetic.zarr', array_path := '0')
WHERE c=0 AND z=1 AND y BETWEEN 1 AND 2 AND x BETWEEN 1 AND 2
ORDER BY y,x;
```

Rejected bounded query:

```sql
SELECT c,z,y,x,value
FROM read_zarr('http://127.0.0.1:5198/synthetic.zarr', array_path := '0',
  bounds := [['z','1','1'],['y','1','2'],['x','1','2'],['c','0','0']]);
```

## Exact artifact, runtime and licenses

- Repository: `xqlsystems/duckdb-zarr`.
- Artifact source commit: `473cb3b203ff0c2f7f330bc6a4c0cbe4ed5c6474`.
- Successful GitHub Actions run: `40233921996`.
- Artifact: `zarr-v2.0.0-extension-wasm_eh`, GitHub artifact ID `12614637670`.
- Extracted file: `zarr.duckdb_extension.wasm`.
- Extracted-file SHA-256:
  `90517bfb2b190cd0f88b8f326c92eac2cf22e47e2aac200082264757bfbdf1e2`.
- GitHub artifact archive digest (not the extracted-file digest):
  `sha256:471f7d8c48ed54f7c3538e7330b73584d6947f86bdb4a731a9530ef9b769d47b`.
- GitHub reported expiry at audit time: `2027-01-23T21:06:38Z`. This is an
  expiring CI artifact, not a permanent release download. Release entries at
  audit time had no binary assets. The setup script deliberately does not
  replace an unavailable artifact with an unverified binary.
- Browser package: `@duckdb/duckdb-wasm@1.33.1-dev110.0` (MIT).
- Browser engine: `v2.0.0-dev88614`, `duckdb-base.wasm` and matching base worker.
- Extension license at the exact source commit: Apache-2.0. The audit saves
  that pinned `LICENSE` alongside its quarantined artifact. No extension
  redistribution or complete transitive-license audit is claimed.
- Unsigned extension loading is explicitly enabled **only in the isolated
  audit runtime**. Production metadata configuration is unchanged.

The tag/artifact label `v2.0.0` alone is not a compatibility guarantee. The
application's `1.33.1-dev57.0` runtime actually reports engine `v1.5.4`, not the
version inferred from its npm package name, and cannot initialize this binary.
The EH-worker compatibility check avoids conflating an MVP/EH feature mismatch
with that explicit C API failure.

## Reproduce

Prerequisites: Node.js 22+, npm, and an authenticated GitHub CLI able to download
public Actions artifacts. The audit installs pinned Vite/Playwright/runtime
packages and Chromium in a scratch environment, verifies the exact CI source
commit and binary digest, starts a real HTTP server with real missing-object
404s, executes SQL in Chromium and checks both results and network requests.
Missing source-map files in the upstream WASM package may emit harmless Vite
warnings; they do not replace, skip or mock the reader.

```sh
# Default setup is deliberately blocked (exit 2); it downloads nothing.
node scripts/setup-duckdb-zarr.mjs

# Exit 0 means the documented BLOCKER was successfully reproduced,
# not that bounded DuckDB-Zarr support was installed.
node scripts/setup-duckdb-zarr.mjs --audit

npm test -- tests/duckdb-zarr.test.ts
```

Scratch defaults to
`~/.hermes/cache/scratch/musivarium-duckdb-bounded-audit/` and may be overridden
with `MUSIVARIUM_AUDIT_DIR`. `audit-result.json` contains the actual engine
versions, error messages, SQL, decoded output rows and every recorded image
HTTP request. The script asserts the 24 unique data-chunk requests, 16
other-plane chunk requests, four correct intensities, coordinate-array failure,
and old-runtime C API failure. Unexpected results fail the audit and require
reevaluation rather than silently declaring support. It does not alter this
repository's dependencies, shared types, Vite configuration or public assets.

## Adapter API / UI integration

`src/sources/duckdb-zarr.ts` exports:

- `DUCKDB_ZARR_AUDIT`: frozen tested pin/hash/license record.
- `DuckDBZarrSource`: standalone capability adapter with
  `backend: 'duckdb-zarr'` and frozen `availability`.
- `DuckDBZarrRegionRequest`: `{url,axes,shape,x,y,width,height,channels,z,t,level,signal?}`.
  XY is a half-open pixel crop at the chosen dataset path (`level`). `z` and
  `t` are scalar indices, never ranges. `axes` and `shape` are the original
  ordered dimensions, not assumed TCZYX.
- `readRegion(request): Promise<never>`: always rejects with
  `DuckDBZarrUnavailableError`, code `UNBOUNDED_OME_READ`, **before any fetch**.
  It does not invoke Zarrita behind the caller's back or return invented pixels.

The intended UI behavior is to show DuckDB-Zarr as unavailable with the reason,
then explicitly use `BrowserSource.readRegion(levelIndex,
{x,y,width,height,z,t,channel})` for the selected bounded plane. A future adapter
may obtain axes/shape from `BrowserSource.alignment(levelIndex)` and reuse
transport, but it must prove extension-level bounded decoding too.

Do not register all original image chunks to compensate for unpruned SQL:
that repeats the full-volume prefetch in the upstream biology demo. Registering
only selected chunks and permitting missing reads to look like fill values
would fabricate pixels and still permit a volume-sized scan. Adding synthetic
coordinate arrays or rewriting image metadata would change the source's
semantics and is not an audited same-original-byte integration.

## Upstream inspected

The source checkout's `demos/biology/README.md`, `extension.sha256`,
`src/main.js` and `src/queries.js` provide the tested artifact/runtime pin. Its
biology demo explicitly prefetches every image chunk, so its successful volume
rendering does not meet this task's access contract. The old binary under
`demos/zarr-map/public/` was not substituted.

`d33bs/picture-thousand-records` was also inspected. Its `README.md` says the
database stores display-scaled per-nucleus JPEG crops, not original source
images, masks or 16-bit pixels. It is a useful metadata/UI precedent, not an
original OME-Zarr raw-ROI transport or proof of DuckDB-Zarr chunk pruning.

To enable a future binary, pin its exact source/hash/runtime, retain its license,
execute a real browser reader on named and reordered OME axes, and assert only
intersecting chunks (including unavoidable boundary/chunk overlap) are fetched.
Verify Z/T/channel isolation, XY edge crops, missing chunks, fill semantics,
dtypes/codecs and memory budgets before changing the capability flag. A
successful `LOAD`, `SELECT version()` or correct cropped SQL output alone is
insufficient.
