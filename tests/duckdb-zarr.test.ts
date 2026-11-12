import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DUCKDB_ZARR_AUDIT,
  DuckDBZarrSource,
  DuckDBZarrUnavailableError,
  type DuckDBZarrRegionRequest,
} from '../src/sources/duckdb-zarr';

const request: DuckDBZarrRegionRequest = {
  url: 'https://example.org/image.zarr',
  axes: ['t', 'c', 'z', 'y', 'x'],
  shape: [1, 2, 3, 40, 50],
  x: 2,
  y: 3,
  width: 8,
  height: 9,
  channels: [0, 1],
  z: 1,
  t: 0,
  level: '0',
};

afterEach(() => vi.unstubAllGlobals());

describe('audited DuckDB-Zarr availability', () => {
  it('setup refuses to install an artifact as bounded support without an explicit audit', () => {
    const result = spawnSync(process.execPath, ['scripts/setup-duckdb-zarr.mjs'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('UNBOUNDED_OME_READ');
    expect(result.stderr).toContain('--audit');
  });
  it('does not claim bounded OME support just because the extension loads', () => {
    const source = new DuckDBZarrSource();
    expect(source.backend).toBe('duckdb-zarr');
    expect(source.availability.available).toBe(false);
    expect(source.availability.code).toBe('UNBOUNDED_OME_READ');
    expect(source.availability.reason).toContain('coordinate array');
    expect(source.availability.reason).toContain('all 24');
  });

  it('records the actual tested runtime and hash, not a release-name guess', () => {
    expect(DUCKDB_ZARR_AUDIT.runtimePackage).toBe('@duckdb/duckdb-wasm@1.33.1-dev110.0');
    expect(DUCKDB_ZARR_AUDIT.engineVersion).toBe('v2.0.0-dev88614');
    expect(DUCKDB_ZARR_AUDIT.sourceCommit).toBe('473cb3b203ff0c2f7f330bc6a4c0cbe4ed5c6474');
    expect(DUCKDB_ZARR_AUDIT.sha256).toBe(
      '90517bfb2b190cd0f88b8f326c92eac2cf22e47e2aac200082264757bfbdf1e2',
    );
    expect(DUCKDB_ZARR_AUDIT.license).toBe('Apache-2.0');
  });

  it('fails closed before any image, metadata, runtime or artifact fetch', async () => {
    const fetch = vi.fn(() => {
      throw new Error('must not fetch');
    });
    vi.stubGlobal('fetch', fetch);
    const source = new DuckDBZarrSource();
    await expect(source.readRegion(request)).rejects.toBeInstanceOf(DuckDBZarrUnavailableError);
    await expect(source.readRegion(request)).rejects.toMatchObject({ code: 'UNBOUNDED_OME_READ' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not manufacture pixels or silently substitute another reader', async () => {
    const source = new DuckDBZarrSource();
    await expect(source.readRegion(request)).rejects.toThrow(/Zarrita/);
  });

  it('keeps the public capability and audit immutable', () => {
    expect(Object.isFrozen(DUCKDB_ZARR_AUDIT)).toBe(true);
    expect(Object.isFrozen(new DuckDBZarrSource().availability)).toBe(true);
  });
});
