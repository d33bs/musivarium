import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Isolated, bounded production-build verification; never starts the app's :5183 server.
export default defineConfig({
  testDir: '..',
  testMatch: 'voice-recorder.spec.ts',
  timeout: 30000,
  workers: 1,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  use: { baseURL: 'http://127.0.0.1:5187/musivarium/', headless: true },
  webServer: {
    command: 'node tests/browser/support/voice-test-server.mjs',
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    url: 'http://127.0.0.1:5187/musivarium/tests/browser/support/voice-recorder.html',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
