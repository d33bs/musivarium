import { build, preview } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const outDir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'musivarium-voice-build-'));
const base = '/musivarium/';
await build({
  configFile: false,
  base,
  worker: { format: 'es' },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: resolve('tests/browser/support/voice-recorder.html') },
  },
});
const server = await preview({
  configFile: false,
  base,
  build: { outDir },
  preview: { host: '127.0.0.1', port: 5187, strictPort: true },
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.httpServer.close();
  await rm(outDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
console.log(
  'Voice-only production harness: http://127.0.0.1:5187/musivarium/tests/browser/support/voice-recorder.html',
);
