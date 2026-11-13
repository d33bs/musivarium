import { describe, it, expect, vi, afterEach } from 'vitest';
import { DUCKDB_ZARR_AUDIT, DuckDBZarrSource } from '../src/sources/duckdb-zarr';
import { DEFAULT_SETTINGS, parseSettings } from '../src/core';
afterEach(() => vi.unstubAllGlobals());
describe('production DuckDB-Zarr reader', () => {
  it('is the default instead of a disabled capability stub', () => {
    expect(DEFAULT_SETTINGS.reader).toBe('duckdb-zarr');
    expect(DUCKDB_ZARR_AUDIT.mode).toBe('bounded-complete-chunk-views');
  });
  it('migrates legacy browser-reader links without a silent Zarrita fallback', () => {
    expect(parseSettings('https://app.test/?reader=browser').reader).toBe('duckdb-zarr');
  });
  it('pins the official community binary and matching engine', () => {
    expect(DUCKDB_ZARR_AUDIT.distribution).toBe('community-extensions.duckdb.org');
    expect(DUCKDB_ZARR_AUDIT.engineVersion).toBe('v2.0.0');
    expect(DUCKDB_ZARR_AUDIT.sha256).toBe(
      'b28752c96e613b74a5575a7f0115d8084820f1c6a99c7f6f729e6babe34a465a',
    );
  });
  it('rejects non-HTTP input before a fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      DuckDBZarrSource.open('file:///bad', new AbortController().signal),
    ).rejects.toThrow(/HTTP/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('honors an already-cancelled request without creating a runtime', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const c = new AbortController();
    c.abort();
    await expect(DuckDBZarrSource.open('https://example.invalid/', c.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps the audit pin immutable', () => expect(Object.isFrozen(DUCKDB_ZARR_AUDIT)).toBe(true));
});
