export interface Attempt {
  url: string;
  bytes: number;
  status: number;
  milliseconds: number;
  started_at_ms?: number;
  error?: string;
}
/** Bounded streaming transport, one retry for interrupted/transient reads, no backend/host substitution. */
export interface TransferUpdate {
  url: string;
  attempt: number;
  state: 'start' | 'headers' | 'data' | 'complete' | 'error';
  received: number;
  total: number | null;
  error?: string;
}
export async function fetchObject(
  request: Request,
  signal: AbortSignal,
  record: (a: Attempt) => void,
  onTransfer?: (update: TransferUpdate) => void,
): Promise<Response> {
  const limit = 16 * 1024 * 1024;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const start = performance.now();
    let status = 0,
      bytes = 0,
      retry = true;
    let total: number | null = null;
    const update = (state: TransferUpdate['state'], error?: string) =>
      onTransfer?.({
        url: request.url,
        attempt: attempt + 1,
        state,
        received: bytes,
        total,
        ...(error ? { error } : {}),
      });
    update('start');
    try {
      const response = await fetch(
        new Request(request, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
          credentials: 'omit',
          ...(attempt ? { cache: 'reload' as const } : {}),
        }),
      );
      status = response.status;
      if (![200, 206, 404].includes(status)) {
        retry = status >= 500;
        throw Error(`HTTP ${status} reading ${request.url}`);
      }
      const expected = Number(response.headers.get('content-length'));
      if (expected > limit) {
        retry = false;
        await response.body?.cancel();
        throw Error('Compressed object exceeds the 16 MiB response limit');
      }
      const encoded = response.headers.get('content-encoding');
      total =
        response.headers.has('content-length') &&
        Number.isFinite(expected) &&
        expected >= 0 &&
        (!encoded || encoded === 'identity')
          ? expected
          : null;
      update('headers');
      const reader = response.body?.getReader(),
        parts: Uint8Array[] = [];
      if (reader)
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > limit) {
            retry = false;
            await reader.cancel();
            throw Error('Compressed object exceeds the 16 MiB response limit');
          }
          if (total !== null && bytes > total) total = null;
          update('data');
          parts.push(part.value);
        }
      const result = new Uint8Array(bytes);
      let offset = 0;
      for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
      }
      record({
        url: request.url,
        bytes,
        status,
        milliseconds: performance.now() - start,
        started_at_ms: start,
      });
      update('complete');
      return new Response(result.buffer, { status, headers: response.headers });
    } catch (error) {
      record({
        url: request.url,
        bytes,
        status,
        milliseconds: performance.now() - start,
        started_at_ms: start,
        error: error instanceof Error ? error.message : String(error),
      });
      update('error', error instanceof Error ? error.message : String(error));
      signal.throwIfAborted();
      if (!retry || attempt === 1)
        throw Error(
          `Unable to read ${request.url}${attempt ? ' after one retry' : ''}: ${error instanceof Error ? error.message : error}. Check network/CORS or try the sample again.`,
        );
    }
  }
  throw Error('Unreachable transport state');
}
