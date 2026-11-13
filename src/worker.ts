/// <reference lib="webworker" />
import { runPipeline } from './pipeline';
import { openImageSource } from './sources/factory';
import type { Settings } from './core';
import { ReadSession } from './sources/read-session';
self.onmessage = async (
  event: MessageEvent<{ id: number; action: 'run' | 'inspect'; settings: Settings }>,
) => {
  const { id, settings, action } = event.data,
    controller = new AbortController();
  const send = (type: string, data: unknown) => self.postMessage({ id, type, data });
  try {
    if (action === 'inspect') {
      const source = await openImageSource(
          settings.source,
          settings.reader,
          controller.signal,
          new ReadSession(controller.signal, (p) => send('network', p)),
        ),
        array = await source.level(settings.level);
      send('metadata', {
        metadata: source.metadata,
        alignment: await source.alignment(settings.level),
        dtype: array.dtype,
        chunks: array.chunks,
      });
      return;
    }
    const result = await runPipeline(settings, {
      signal: controller.signal,
      onProgress: (p) => send('progress', p),
      onNetwork: (p) => send('network', p),
      onBatch: (p) => send('batch', p),
    });
    send('result', result);
  } catch (error) {
    send('error', error instanceof Error ? error.message : String(error));
  }
};
