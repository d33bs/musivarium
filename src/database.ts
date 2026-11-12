import * as duckdb from '@duckdb/duckdb-wasm';
import { tableFromJSON } from 'apache-arrow';
import { cellRow, type Cell } from './pipeline';
import { validateSelect } from './exports';
const vendor = new URL(`${import.meta.env.BASE_URL}vendor/`, location.href).href;
let enginePromise:
  Promise<{ db: duckdb.AsyncDuckDB; connection: duckdb.AsyncDuckDBConnection }> | undefined;
export function database() {
  return (enginePromise ??= openDatabase());
}
async function openDatabase() {
  try {
    const bundle = await duckdb.selectBundle({
        mvp: {
          mainModule: vendor + 'duckdb-mvp.wasm',
          mainWorker: vendor + 'duckdb-browser-mvp.worker.js',
        },
        eh: {
          mainModule: vendor + 'duckdb-eh.wasm',
          mainWorker: vendor + 'duckdb-browser-eh.worker.js',
        },
      }),
      worker = new Worker(bundle.mainWorker!),
      db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule);
    await db.open({ query: { castBigIntToDouble: true, castTimestampToDate: true } });
    const connection = await db.connect();
    await connection.query(`SET custom_extension_repository='${vendor}extensions'`);
    await connection.query('SET autoinstall_known_extensions=false');
    await connection.query('SET autoload_known_extensions=false');
    return { db, connection };
  } catch (e) {
    enginePromise = undefined;
    throw Error(
      `Cannot start local DuckDB. Run npm run setup:assets and rebuild. ${e instanceof Error ? e.message : e}`,
    );
  }
}
let generation = 0;
let loadQueue: Promise<unknown> = Promise.resolve();
export function loadCells(cells: Cell[]): Promise<boolean> {
  const id = ++generation;
  const load = loadQueue
    .catch(() => {})
    .then(async () => {
      const { connection } = await database();
      if (id !== generation) return false;
      await connection.query('DROP TABLE IF EXISTS cells');
      if (cells.length)
        await connection.insertArrowTable(tableFromJSON(cells.map(cellRow)), {
          name: 'cells',
          create: true,
        });
      else
        await connection.query(
          'CREATE TABLE cells(cell_id VARCHAR, area INTEGER, cx DOUBLE, cy DOUBLE)',
        );
      return id === generation;
    });
  loadQueue = load;
  return load;
}
export async function queryCells(sql: string) {
  const { connection } = await database(),
    table = await connection.query(
      `SELECT * FROM (${validateSelect(sql)}) AS query_result LIMIT 10001`,
    ),
    rows = table
      .toArray()
      .map((row) =>
        JSON.parse(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))),
      );
  if (rows.length > 10000) throw Error('Query result exceeds the 10,000-row limit');
  return {
    rows: rows as Record<string, unknown>[],
    columns: table.schema.fields.map((f) => f.name),
  };
}
let parquetPromise: Promise<void> | undefined;
async function ensureParquet() {
  return (parquetPromise ??= (async () => {
    const { connection } = await database();
    await connection.query('INSTALL parquet');
    await connection.query('LOAD parquet');
  })().catch((e) => {
    parquetPromise = undefined;
    throw Error(
      `Pinned local Parquet extension unavailable; run npm run setup:assets and rebuild. ${e instanceof Error ? e.message : e}`,
    );
  }));
}
export async function exportTable(sql: string, format: 'csv' | 'parquet'): Promise<Uint8Array> {
  const { db, connection } = await database(),
    query = validateSelect(sql),
    name = `musivarium.${format}`;
  if (format === 'parquet') await ensureParquet();
  await connection.query(
    `COPY (${query}) TO '${name}' (FORMAT ${format.toUpperCase()}${format === 'csv' ? ', HEADER TRUE' : ''})`,
  );
  const bytes = await db.copyFileToBuffer(name);
  await db.dropFile(name);
  return bytes;
}
