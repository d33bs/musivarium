import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 120000,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  use: { baseURL: 'http://127.0.0.1:5183', headless: true },
  webServer: {
    command: 'npm run dev -- --port 5183 --strictPort',
    url: 'http://127.0.0.1:5183',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
