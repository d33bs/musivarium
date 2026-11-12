/**
 * Fail-closed capability adapter, NOT a pixel implementation.
 *
 * A real Chromium audit loaded the pinned extension and queried original
 * synthetic Zarr bytes. WHERE returned the right crop but fetched every chunk;
 * bounds := failed on ordinary OME axes without stored coordinate arrays.
 * See docs/duckdb-zarr.md and scripts/setup-duckdb-zarr.mjs --audit.
 */
export const DUCKDB_ZARR_AUDIT = Object.freeze({
  runtimePackage: '@duckdb/duckdb-wasm@1.33.1-dev110.0',
  engineVersion: 'v2.0.0-dev88614',
  sourceCommit: '473cb3b203ff0c2f7f330bc6a4c0cbe4ed5c6474',
  artifactRun: '40233921996',
  artifactName: 'zarr-v2.0.0-extension-wasm_eh',
  sha256: '90517bfb2b190cd0f88b8f326c92eac2cf22e47e2aac200082264757bfbdf1e2',
  license: 'Apache-2.0',
});

/** Half-open XY crop coordinates in the selected level; exactly one scalar Z/T. */
export interface DuckDBZarrRegionRequest {
  readonly url: string;
  /** Ordered source dimensions, e.g. ['t', 'c', 'z', 'y', 'x']. */
  readonly axes: readonly string[];
  readonly shape: readonly number[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly channels: readonly number[];
  readonly z: number;
  readonly t: number;
  readonly level: string;
  readonly signal?: AbortSignal;
}

const availability = Object.freeze({
  available: false as const,
  code: 'UNBOUNDED_OME_READ' as const,
  reason:
    'DuckDB-Zarr bounds requires a stored coordinate array for each bounded dimension. ' +
    'The audited OME-Zarr WHERE crop fetched all 24 chunks, including other Z planes and channels. ' +
    'Use the bounded Zarrita reader; no DuckDB-Zarr image reads are enabled.',
});

export class DuckDBZarrUnavailableError extends Error {
  readonly code = availability.code;
  constructor() {
    super(availability.reason);
    this.name = 'DuckDBZarrUnavailableError';
  }
}

/**
 * Explicitly unavailable until a newly pinned artifact proves chunk-bounded
 * single-plane image access in a browser. This class intentionally imports no
 * DuckDB runtime and performs no fetch, SQL, fallback, or volume prefetch.
 */
export class DuckDBZarrSource {
  readonly backend = 'duckdb-zarr' as const;
  readonly availability = availability;

  async readRegion(_request: DuckDBZarrRegionRequest): Promise<never> {
    throw new DuckDBZarrUnavailableError();
  }
}
