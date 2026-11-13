#!/usr/bin/env node
/**
 * Install the pinned official runtime/extensions for the production chunk-view
 * reader. --audit separately reproduces direct whole-store bounds limitations
 * in an isolated scratch project using INSTALL zarr FROM community.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PIN = Object.freeze({
  repository: 'xqlsystems/duckdb-zarr',
  distribution: 'community-extensions.duckdb.org',
  maintainers: ['alxmrs', 'd33bs'],
  duckdbVersion: 'v2.0.0',
  platform: 'wasm_eh',
  url: 'https://community-extensions.duckdb.org/v2.0.0/wasm_eh/zarr.duckdb_extension.wasm',
  sha256: 'b28752c96e613b74a5575a7f0115d8084820f1c6a99c7f6f729e6babe34a465a',
  runtime: '1.33.1-dev114.0',
  engine: 'v2.0.0',
  realDataset: 'https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr',
});

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await import('./setup-assets.mjs');
  } else if (args.length === 1 && args[0] === '--audit') {
    await audit();
  } else {
    console.error('Usage: node scripts/setup-duckdb-zarr.mjs [--audit]');
    process.exitCode = 2;
  }
}

async function audit() {
  const root = resolve(
    process.env.MUSIVARIUM_AUDIT_DIR ??
      join(homedir(), '.hermes', 'cache', 'scratch', 'musivarium-duckdb-community-audit'),
  );
  await mkdir(root, { recursive: true });
  const response = await fetch(PIN.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error(`Pinned community extension download HTTP ${response.status}`);
  const binary = new Uint8Array(await response.arrayBuffer());
  const digest = createHash('sha256').update(binary).digest('hex');
  if (digest !== PIN.sha256) throw Error(`Extension SHA-256 mismatch: ${digest}`);

  const packageJSON = {
    private: true,
    type: 'module',
    dependencies: { '@duckdb/duckdb-wasm': PIN.runtime },
    devDependencies: { vite: '8.3.8', '@playwright/test': '1.65.0' },
  };
  await writeFile(join(root, 'package.json'), `${JSON.stringify(packageJSON, null, 2)}\n`);
  await writeFile(join(root, 'vite.config.js'), "export default { appType: 'mpa' };\n");
  const { execFileSync } = await import('node:child_process');
  const run = (command, cmdArgs) =>
    execFileSync(command, cmdArgs, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 180_000,
    });
  console.log(run('npm', ['install', '--ignore-scripts']));
  console.log(run('npm', ['exec', '--', 'playwright', 'install', 'chromium']));

  // Verify the public distribution before running it; installation itself uses
  // INSTALL zarr FROM community in the browser, not a custom repository.
  await fixture(join(root, 'public'), false);
  await fixture(join(root, 'public'), true);
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><title>Community duckdb-zarr audit</title><script type="module" src="/audit.js"></script>',
  );
  await writeFile(join(root, 'audit.js'), BROWSER_PROBE(PIN.realDataset));
  await writeFile(join(root, 'run-browser.mjs'), RUN_BROWSER);
  console.log(run(process.execPath, ['run-browser.mjs']));

  const { trials } = JSON.parse(await readFile(join(root, 'audit-result.json'), 'utf8'));
  const trial = (name) => {
    const result = trials.find((t) => t.name === name);
    if (!result || result.version !== PIN.engine || result.pageErrors.length)
      throw Error(`Trial ${name} failed runtime checks`);
    if (
      !result.extensions.length ||
      result.extensions.some(
        (e) =>
          e.status !== 200 ||
          e.sha256 !== PIN.sha256 ||
          new URL(e.url).hostname !== PIN.distribution,
      )
    )
      throw Error(`Trial ${name} did not load the pinned public community extension`);
    return result;
  };
  const where = trial('synthetic-where'),
    bounded = trial('synthetic-bounds'),
    control = trial('coordinates-bounds'),
    realWhere = trial('real-where'),
    realBounds = trial('real-bounds'),
    suppliedBounds = trial('supplied-bounds');
  for (const check of [where, control]) {
    if (check.error || JSON.stringify(check.rows?.map((r) => r.value)) !== '[111,112,121,122]')
      throw Error(`${check.name}: wrong SQL values: ${check.error}`);
  }
  const otherPlanes = where.chunkRequests.filter(
    (url) => new URL(url).pathname.split('/').at(-1).split('.')[1] !== '1',
  );
  if (otherPlanes.length !== 16 || where.chunkRequests.length !== 24)
    throw Error('WHERE scan behavior changed; reevaluate bounded support');
  for (const check of [bounded, realBounds, suppliedBounds]) {
    if (!check.error?.includes('no coordinate array') || check.chunkRequests.length !== 0)
      throw Error(`${check.name}: positional bounds behavior changed; reevaluate support`);
  }
  const expected = ['0.1.0.0', '0.1.0.1', '0.1.1.0', '0.1.1.1'];
  if (
    JSON.stringify(
      control.chunkRequests.map((url) => new URL(url).pathname.split('/').at(-1)).sort(),
    ) !== JSON.stringify(expected)
  )
    throw Error(
      'Explicit-coordinate positive control did not prune to exactly the four intersecting chunks',
    );
  if (
    realWhere.error ||
    realWhere.chunkRequests.length !== 50 ||
    !Number.isFinite(realWhere.rows?.[0]?.mean) ||
    Math.abs(realWhere.rows[0].mean - 17.040815875715996) > 1e-6
  )
    throw Error('Real IDR channel scan did not reproduce; inspect audit-result.json');
  console.log(
    JSON.stringify(
      {
        direct_store_bounds_supported: false,
        production_reader_mode: 'bounded-complete-chunk-views',
        code: 'UNBOUNDED_OME_READ',
        pin: PIN,
        installation: 'INSTALL zarr FROM community; LOAD zarr;',
        trials: trials.map((t) => ({
          name: t.name,
          dataChunks: t.chunkRequests.length,
          error: t.error,
        })),
        evidence: join(root, 'audit-result.json'),
      },
      null,
      2,
    ),
  );
}

/** Explicit synthetic FORMAT fixture, not a biological dataset or mocked SQL. */
async function fixture(publicDir, coordinates) {
  const root = join(publicDir, coordinates ? 'coordinates.zarr' : 'synthetic.zarr');
  const metadata = {};
  const json = async (path, data) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(data));
    metadata[path.slice(root.length + 1)] = data;
  };
  await json(join(root, '.zgroup'), { zarr_format: 2 });
  await json(join(root, '.zattrs'), {
    multiscales: [
      {
        version: '0.4',
        axes: ['c', 'z', 'y', 'x'].map((name) => ({
          name,
          type: name === 'c' ? 'channel' : 'space',
        })),
        datasets: [{ path: '0' }],
      },
    ],
  });
  await json(join(root, '0', '.zarray'), {
    zarr_format: 2,
    shape: [2, 3, 4, 4],
    chunks: [1, 1, 2, 2],
    dtype: '<u2',
    compressor: null,
    fill_value: 0,
    order: 'C',
    filters: null,
  });
  await json(join(root, '0', '.zattrs'), { _ARRAY_DIMENSIONS: ['c', 'z', 'y', 'x'] });
  if (coordinates) {
    for (const [dim, length] of [
      ['c', 2],
      ['z', 3],
      ['y', 4],
      ['x', 4],
    ]) {
      await json(join(root, dim, '.zarray'), {
        zarr_format: 2,
        shape: [length],
        chunks: [length],
        dtype: '<i4',
        compressor: null,
        fill_value: null,
        order: 'C',
        filters: null,
      });
      await json(join(root, dim, '.zattrs'), { _ARRAY_DIMENSIONS: [dim] });
      const data = Buffer.alloc(length * 4);
      for (let i = 0; i < length; i++) data.writeInt32LE(i, i * 4);
      await writeFile(join(root, dim, '0'), data);
    }
  }
  // Consolidate BOTH format stores so only the presence of coordinates differs.
  await writeFile(
    join(root, '.zmetadata'),
    JSON.stringify({ zarr_consolidated_format: 1, metadata }),
  );
  for (let c = 0; c < 2; c++)
    for (let z = 0; z < 3; z++) {
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) {
          const buffer = Buffer.alloc(8);
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              buffer.writeUInt16LE(
                c * 1000 + z * 100 + (y * 2 + dy) * 10 + x * 2 + dx,
                2 * (dy * 2 + dx),
              );
            }
          await writeFile(join(root, '0', `${c}.${z}.${y}.${x}`), buffer);
        }
    }
}

const BROWSER_PROBE = (realDataset) => `
import * as duckdb from '@duckdb/duckdb-wasm';
import mainModule from '@duckdb/duckdb-wasm/dist/duckdb-base.wasm?url';
import mainWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url&worker';
async function engine() {
  const worker = new Worker(mainWorker, { type: 'module' });
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(mainModule);
  await db.open({ allowUnsignedExtensions: true });
  const connection = await db.connect();
  await connection.query('SET autoinstall_known_extensions=false');
  await connection.query('SET autoload_known_extensions=false');
  await connection.query('INSTALL zarr FROM community');
  await connection.query('LOAD zarr');
  return { db, connection };
}
window.runTrial = async (name) => {
  const { db, connection } = await engine();
  try {
    const version = (await connection.query('SELECT version() AS v')).toArray()[0].v;
    const bounds = "[['c','0','0'],['z','1','1'],['y','1','2'],['x','1','2']]";
    const formatSource = location.origin + (name === 'coordinates-bounds' ? '/coordinates.zarr' : '/synthetic.zarr');
    const sqls = {
      'synthetic-where': "SELECT c,z,y,x,value FROM read_zarr('" + formatSource + "', array_path := '0') WHERE c=0 AND z=1 AND y BETWEEN 1 AND 2 AND x BETWEEN 1 AND 2 ORDER BY y,x",
      'synthetic-bounds': "SELECT c,z,y,x,value FROM read_zarr('" + formatSource + "', array_path := '0', bounds := " + bounds + ") ORDER BY y,x",
      'coordinates-bounds': "SELECT c,z,y,x,value FROM read_zarr('" + formatSource + "', array_path := '0', bounds := " + bounds + ") ORDER BY y,x",
      'supplied-bounds': "SELECT c,y,x,value FROM read_zarr('https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/', array_path := '0', bounds := [['c','0','0'],['y','0','63'],['x','0','63']]) ORDER BY y,x",
      'real-where': "SELECT c, AVG(value) AS mean FROM read_zarr('${realDataset}', array_path := '0') WHERE c = 42 GROUP BY c",
      'real-bounds': "SELECT c,y,x,value FROM read_zarr('${realDataset}', array_path := '0', bounds := [['c','42','42'],['y','0','63'],['x','0','63']]) ORDER BY y,x",
    };
    const sql = sqls[name];
    if (!sql) throw Error('Unknown audit trial: ' + name);
    try {
      const rows = (await connection.query(sql)).toArray().map(row =>
        Object.fromEntries(Object.entries(row.toJSON()).map(([k,v]) => [k,typeof v==='bigint'?Number(v):v])));
      return { name, version, sql, rows };
    } catch (e) {
      return { name, version, sql, error: e.message };
    }
  } finally {
    await connection.close(); await db.terminate();
  }
};
`;

const RUN_BROWSER = `
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const server = await createServer({appType:'mpa',server:{host:'127.0.0.1',port:0,hmr:false}});
await server.listen();
const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
let browser;
try {
  browser = await chromium.launch({headless:true});
  const trials = [];
  for (const name of ['synthetic-where','synthetic-bounds','coordinates-bounds','real-where','real-bounds','supplied-bounds']) {
    const page = await browser.newPage();
    const requests=[], pageErrors=[], signatures=[];
    const extensionResponses=[];
    page.on('request',request=>requests.push({url:request.url(),method:request.method()}));
    page.on('pageerror',e=>pageErrors.push(e.message));
    page.on('response',response=>{
      if (response.url().endsWith('/zarr.duckdb_extension.wasm')) {
        extensionResponses.push(response.body().then(body=>{
          signatures.push({url:response.url(),status:response.status(),sha256:createHash('sha256').update(body).digest('hex')});
        }));
      }
    });
    await page.goto(origin);
    await page.waitForFunction(()=>typeof window.runTrial === 'function',undefined,{timeout:30000});
    const timeout=setTimeout(()=>void page.close(),90000);
    let result;
    try { result=await page.evaluate(name=>window.runTrial(name),name); }
    finally { clearTimeout(timeout); }
    await Promise.all(extensionResponses);
    result.requests=requests;
    result.pageErrors=pageErrors;
    result.extensions=signatures;
    result.chunkRequests=[...new Set(requests.filter(r=>r.method==='GET').map(r=>r.url).filter(url=>{
      const p=new URL(url).pathname;
      return /\\/0\\/\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(p) || /10501752.zarr\\/0\\/\\d+\\/\\d+\\/\\d+$/.test(p) || /BR00109990_C2.zarr\\/0\\/0\\/c\\//.test(p);
    }))];
    trials.push(result);
    await writeFile('audit-result.json',JSON.stringify({trials},null,2));
    console.log(JSON.stringify({name,error:result.error,rows:result.rows?.length,chunks:result.chunkRequests.length,extensions:result.extensions}));
    await page.close();
  }
} finally {await browser?.close();await server.close();}
`;

await main();
