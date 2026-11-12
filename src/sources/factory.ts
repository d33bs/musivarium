import type { ReaderBackend } from '../core';
import type { ImageSource } from './types';
import { BrowserSource } from './browser';
import type { ReadSession } from './read-session';
import { DuckDBZarrUnavailableError } from './duckdb-zarr';
export async function openImageSource(
  url: string,
  backend: ReaderBackend,
  signal: AbortSignal,
  session?: ReadSession,
): Promise<ImageSource> {
  signal.throwIfAborted();
  if (backend === 'duckdb-zarr') throw new DuckDBZarrUnavailableError();
  return BrowserSource.open(url, signal, session);
}
