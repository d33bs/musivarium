import { defineConfig } from 'vitest/config';
export default defineConfig({
  base: process.env.BASE_PATH || './',
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15000 },
});
