import type { ReaderBackend } from '../core';
import { DuckDBZarrSource } from './duckdb-zarr';
import type { ReadSession } from './read-session';
/** Legacy shared links also use DuckDB-Zarr; there is no Zarrita fallback. */
export async function openImageSource(
  url: string,
  _backend: ReaderBackend,
  signal: AbortSignal,
  session?: ReadSession,
) {
  signal.throwIfAborted();
  return DuckDBZarrSource.open(url, signal, session);
}
