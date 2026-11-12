import { fetchObject, type Attempt, type TransferUpdate } from './transport';
export interface NetworkProgress {
  active: number;
  queued: number;
  completed: number;
  requests: number;
  receivedBytes: number;
  totalBytes: number | null;
  retries: number;
  maxActive: number;
  decodedBytes: number;
  maxDecodedBytes: number;
  files: string[];
}
type Waiter = {
  weight: number;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
/** FIFO permits shared by all image and label sources, not four per channel. */
class PermitPool {
  used = 0;
  queue: Waiter[] = [];
  constructor(
    readonly capacity: number,
    private changed: () => void,
  ) {}
  acquire(weight: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (weight > this.capacity) throw Error('Read exceeds the shared decoded-memory budget');
    return new Promise((resolve, reject) => {
      const item: Waiter = {
        weight,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
          this.drain();
        },
      };
      signal.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item);
      this.drain();
    });
  }
  private drain() {
    while (this.queue.length && this.used + this.queue[0].weight <= this.capacity) {
      const item = this.queue.shift()!;
      item.signal.removeEventListener('abort', item.abort);
      if (item.signal.aborted) {
        item.reject(item.signal.reason);
        continue;
      }
      this.used += item.weight;
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        this.used -= item.weight;
        this.drain();
      });
    }
    this.changed();
  }
}
export class ReadSession {
  private controller = new AbortController();
  readonly signal: AbortSignal;
  private network: PermitPool;
  private decoded: PermitPool;
  private events = new Map<string, TransferUpdate>();
  private next = 0;
  private bytes = 0;
  private lastEmit = 0;
  private peak = 0;
  private peakDecoded = 0;
  constructor(
    signal: AbortSignal,
    private onProgress?: (progress: NetworkProgress) => void,
    maxRequests = 4,
  ) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 4)
      throw Error('Read concurrency must be 1–4');
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.network = new PermitPool(maxRequests, () => this.emit(true));
    this.decoded = new PermitPool(64 * 1024 * 1024, () => this.emit(true));
  }
  cancel(reason?: unknown) {
    this.controller.abort(reason);
  }
  async request(request: Request, record: (attempt: Attempt) => void): Promise<Response> {
    const id = ++this.next,
      release = await this.network.acquire(1, this.signal);
    try {
      return await fetchObject(request, this.signal, record, (event) => {
        const key = `${id}/${event.attempt}`,
          previous = this.events.get(key);
        this.bytes += event.received - (previous?.received ?? 0);
        this.events.set(key, event);
        if (this.bytes > 96 * 1024 * 1024) {
          const error = Error('Combined image + label network budget exceeded (96 MiB)');
          this.cancel(error);
          throw error;
        }
        this.emit(event.state !== 'data');
      });
    } finally {
      release();
    }
  }
  async reserveDecoded(bytes: number): Promise<() => void> {
    return this.decoded.acquire(bytes, this.signal);
  }
  snapshot(): NetworkProgress {
    const entries = [...this.events.values()],
      ongoing = entries.filter((e) => !['complete', 'error'].includes(e.state));
    const unknown = this.network.queue.length > 0 || ongoing.some((e) => e.total === null);
    const known = entries.reduce(
      (sum, e) =>
        sum +
        (e.state === 'complete' || e.state === 'error' ? e.received : (e.total ?? e.received)),
      0,
    );
    return {
      active: this.network.used,
      queued: this.network.queue.length,
      completed: entries.filter((e) => e.state === 'complete').length,
      requests: entries.length,
      receivedBytes: this.bytes,
      totalBytes: unknown ? null : known,
      retries: entries.filter((e) => e.attempt > 1).length,
      maxActive: this.peak,
      decodedBytes: this.decoded.used,
      maxDecodedBytes: this.peakDecoded,
      files: ongoing.map((e) => e.url),
    };
  }
  private emit(force: boolean) {
    if (!this.network || !this.decoded) return;
    this.peak = Math.max(this.peak, this.network.used);
    this.peakDecoded = Math.max(this.peakDecoded, this.decoded.used);
    const now = performance.now();
    if (!force && now - this.lastEmit < 100) return;
    this.lastEmit = now;
    this.onProgress?.(this.snapshot());
  }
}
