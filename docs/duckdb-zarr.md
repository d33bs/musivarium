# DuckDB-Zarr image reading

DuckDB-Zarr is the demo's image and label reader. There is no Zarrita
production fallback. Zarrita is a development-only dependency used by older
reference tests; production bundles do not include its codecs or reader.

## The bounded path

1. Read original OME-NGFF group and selected-level array JSON over HTTP.
2. Validate axes, shape, dtype, codec, XY bounds and scalar channel/T/Z
   selection. Reject chunks spanning multiple T/Z indices, unsupported
   codecs, sharded arrays and reads above the logical memory/request caps.
3. Download **only intersecting original compressed chunks**, under the
   existing four-request transport semaphore, retry/progress reporting,
   16 MiB response limit and combined 96 MiB response budget.
4. Register each unchanged compressed chunk in DuckDB's memory filesystem
   as a **complete single-chunk Zarr view**. The view is an explicitly
   derived decoder wrapper, not a remote dataset or sparse copy of the
   original volume. Its shape equals the source's chunk shape; every data
   chunk that its metadata declares is registered.
5. `read_zarr` in the official community extension decodes the chunk; SQL
   selects its local XY/channel/T/Z indices. Copy those native values into
   the requested row-major crop using the original global chunk origin.
6. Drop all registered view files in `finally`. Registration, SQL and
   disposal are serialized across image/channel/label requests.

Wrapper metadata is generated, but **biological pixel values and original
compressed payloads are not generated, recompressed or quantized**. V2
compressor/endian descriptors are represented as equivalent V3 codec
metadata; V3 codec descriptors are retained. No coordinate arrays are
invented, and the remote source metadata is never rewritten.

SQL uses a reserved `https://musivarium-chunk.invalid/<uuid>.zarr/` handle
for DuckDB's in-memory filesystem. That handle is never a network source.
Run JSON records `stats.decoding_backend='duckdb-zarr'` and each view's
`original_chunk_url`, original array shape, global chunk origin, generated
wrapper metadata, executed SQL and returned row count. Source URLs, dtype,
physical transforms, measurements and cell IDs retain their original
meaning. Native exports contain source values, not rendered grayscale data.

Missing/corrupt data or extension failures are errors, not fill-value or
Zarrita substitutions. The 24 MiB compressed cache is per source; 64 MiB
aggregate decoded-chunk reservations are shared. DuckDB/Arrow/WASM runtime
memory is additional: these logical caps are not a browser-RSS guarantee.

## Why not query the original whole image with WHERE?

The tested community binary's positional OME axes have no stored coordinate
arrays. Its `bounds` parameter rejects them; ordinary SQL WHERE returns the
right pixels but scans extra chunks. This is **not** how the demo reads
images. Complete, chunk-sized views bound what DuckDB can scan and decode
without pretending that missing original-volume chunks are background.

The separate direct-store audit remains reproducible:

```sh
node scripts/setup-duckdb-zarr.mjs --audit
```

It runs literal `INSTALL zarr FROM community; LOAD zarr;` in Chromium,
verifies the actual public download's hash, and checks six direct-store
cases. A positional-axis 2×2 crop scans 24/24 chunks under WHERE; explicit
bounds fails before data reads. An explicit-coordinate positive control
prunes to the four intersecting chunks. A one-channel WHERE against IDR0076
reads 50 channels, while explicit bounds rejects both real IDR presets.
This audit documents upstream direct-store behavior; it is not the
production single-chunk-view regression test.

## Official runtime and assets

- `@duckdb/duckdb-wasm@1.33.1-dev114.0`, engine checked as `v2.0.0` at startup.
- Official community binary: `https://community-extensions.duckdb.org/v2.0.0/wasm_eh/zarr.duckdb_extension.wasm`.
- SHA-256: `b28752c96e613b74a5575a7f0115d8084820f1c6a99c7f6f729e6babe34a465a`.
- Apache-2.0 extension project: `xqlsystems/duckdb-zarr`.

`npm run setup:assets` downloads the official published binary and the
matching Parquet extension, verifies pinned sizes/hashes, and self-hosts
them alongside the WASM runtime. This is not an independent/CI build.
Runtime loading accepts only the hard-coded same-origin extension pins and
checks their bytes before installation; automatic extension installation
and autoload stay disabled. This tested runtime needs
`allowUnsignedExtensions=true` for the community WASM; the explicit
size/SHA-256 checks are therefore enforced before loading.

## Verification

```sh
npm run setup:assets
npm run check
npm run test:browser
npm run test:static
node scripts/validate-live.mjs --browser chromium --report /path/live.json
node scripts/validate-live.mjs --browser firefox --report /path/live-firefox.json
```

- `tests/duckdb-chunks.test.ts`: selected chunk keys, single-T/Z restriction,
  memory/region validation and native codec-wrapper descriptors.
- `tests/browser/duckdb-reader.spec.ts`: the real auto-loading demo uses
  DuckDB-Zarr for images and labels, with no extra source-channel chunks or
  virtual-namespace network requests. Every registered compressed payload
  and its memory-file readback matches the original fixture SHA-256.
- The same browser test compares an exact 64×64 image/label ROI crossing a
  label-chunk boundary with independently pinned Python native-byte hashes:
  Float64 image `7a5ea59c974ffb6bd7b0f3fb730c72079e40cb843b4545fd5b35cc001c0655b0`,
  Int16 labels `bdcdeb5694767bc44c355c57ed26b2faf3818752628e91f46093d1afd2cdc5d2`.
  It verifies three data registrations existed and zero view files remain.
- `tests/browser/duckdb-failure.spec.ts`: corrupt original chunks and altered
  extension bytes fail without fallback; a clean reload recovers.
- Production root/project-prefix runs in Chromium and Firefox generate 100
  real-fixture objects, readable Parquet exports and real StarDist inference.
- Live, non-intercepted IDR0076 reads in Chromium and Firefox match both
  native hashes and all 25 independent object measurements exactly.
- A live 64×64 channel-0 read from the supplied NGFF 0.5 source fetched one
  original Zstd chunk. Independent NumPy/numcodecs decoding of that exact
  browser response matched ROI SHA-256
  `bd51cab99d6482bbe0f0c573d622e20f7590e79aeb198fa0306d44b7a809d69e`.
  Separate Python HTTP download attempts truncated; using the complete
  captured browser response avoids confusing transport failure with codec
  parity. That source remains susceptible to remote transport interruptions.

No public deployment, Safari verification or browser-memory RSS claim is
implied by these local checks.
