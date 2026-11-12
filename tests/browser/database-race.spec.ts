import { test, expect } from '@playwright/test';
test('overlapping real Arrow table loads serialize and publish only the newest sample', async ({
  page,
}) => {
  await page.goto('/src/database.ts');
  const result = await page.evaluate(async () => {
    const path = '/src/database.ts';
    const { database, loadCells, queryCells } = await import(path);
    const { connection } = await database();
    const original = connection.query.bind(connection);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      seen = new Promise<void>((r) => (started = r));
    let first = true;
    connection.query = async (sql: string) => {
      if (first && sql === 'DROP TABLE IF EXISTS cells') {
        first = false;
        started();
        await gate;
      }
      return original(sql);
    };
    const record = (cell_id: string) => ({
      cell_id,
      source: 'https://example.invalid/metadata-only',
      area: 1,
      label: 1,
      channels: [0],
      means: [42],
      crop: { x: 0, y: 0, width: 1, height: 1, channels: [new Uint16Array([42])] },
    });
    const a = loadCells([record('old')]);
    await seen;
    const b = loadCells([record('new')]);
    release();
    const outcomes = await Promise.allSettled([a, b]);
    return {
      outcomes: outcomes.map((o) => o.status),
      rows: (await queryCells('SELECT cell_id FROM cells')).rows,
    };
  });
  expect(result.outcomes).toEqual(['fulfilled', 'fulfilled']);
  expect(result.rows).toEqual([{ cell_id: 'new' }]);
});
