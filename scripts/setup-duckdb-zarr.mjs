#!/usr/bin/env node
/**
 * No production artifact is installed: the pinned reader fails the bounded-ROI
 * requirement. --audit reproduces the REAL browser SQL/network regression in
 * a separate scratch project. It never fetches an image dataset or changes
 * this project's package.json, node_modules, or public/ directory.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const PIN = Object.freeze({
  repository: 'xqlsystems/duckdb-zarr',
  sourceCommit: '473cb3b203ff0c2f7f330bc6a4c0cbe4ed5c6474',
  run: '40233921996',
  artifact: 'zarr-v2.0.0-extension-wasm_eh',
  sha256: '90517bfb2b190cd0f88b8f326c92eac2cf22e47e2aac200082264757bfbdf1e2',
  runtime: '1.33.1-dev110.0',
  engine: 'v2.0.0-dev88614',
  metadataRuntime: '1.33.1-dev57.0',
});
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--audit') {
    console.error('UNBOUNDED_OME_READ: DuckDB-Zarr is unavailable for single-plane OME crops.');
    console.error(
      'No production artifacts installed. Run node scripts/setup-duckdb-zarr.mjs --audit to reproduce the browser blocker.',
    );
    process.exitCode = 2;
  } else {
    await audit();
  }
}

async function audit() {
  const root = resolve(
    process.env.MUSIVARIUM_AUDIT_DIR ??
      join(homedir(), '.hermes', 'cache', 'scratch', 'musivarium-duckdb-bounded-audit'),
  );
  const artifactDir = join(root, 'artifact');
  await mkdir(artifactDir, { recursive: true });
  const run = (command, args, cwd = root) =>
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 180_000,
    });
  const workflow = JSON.parse(
    run('gh', ['run', 'view', PIN.run, '--repo', PIN.repository, '--json', 'headSha,conclusion']),
  );
  if (workflow.headSha !== PIN.sourceCommit || workflow.conclusion !== 'success')
    throw Error('Pinned CI source/conclusion mismatch');
  const binary = join(artifactDir, 'zarr.duckdb_extension.wasm');
  try {
    await readFile(binary);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    run('gh', [
      'run',
      'download',
      PIN.run,
      '--repo',
      PIN.repository,
      '--name',
      PIN.artifact,
      '--dir',
      artifactDir,
    ]);
  }
  const digest = createHash('sha256')
    .update(await readFile(binary))
    .digest('hex');
  if (digest !== PIN.sha256) throw Error(`Extension SHA-256 mismatch: ${digest}`);
  const license = await fetch(
    `https://raw.githubusercontent.com/${PIN.repository}/${PIN.sourceCommit}/LICENSE`,
  );
  if (!license.ok) throw Error(`Pinned LICENSE returned HTTP ${license.status}`);
  await writeFile(join(artifactDir, 'LICENSE'), await license.text());
  const packageJSON = {
    private: true,
    type: 'module',
    dependencies: {
      '@duckdb/duckdb-wasm': PIN.runtime,
      'duckdb-metadata-runtime': `npm:@duckdb/duckdb-wasm@${PIN.metadataRuntime}`,
      vite: '7.3.7',
      '@playwright/test': '1.65.0',
    },
  };
  await writeFile(join(root, 'package.json'), `${JSON.stringify(packageJSON, null, 2)}\n`);
  console.log(run('npm', ['install', '--ignore-scripts']));
  console.log(run('npm', ['exec', '--', 'playwright', 'install', 'chromium']));
  const publicDir = join(root, 'public');
  await mkdir(publicDir, { recursive: true });
  await copyFile(binary, join(publicDir, 'zarr.duckdb_extension.wasm'));
  await fixture(publicDir);
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><title>Synthetic Zarr read audit</title><script type="module" src="/audit.js"></script>',
  );
  await writeFile(join(root, 'audit.js'), BROWSER_PROBE);
  await writeFile(join(root, 'run-browser.mjs'), RUN_BROWSER);
  console.log(run(process.execPath, ['run-browser.mjs']));
  const result = JSON.parse(await readFile(join(root, 'audit-result.json'), 'utf8'));
  if (result.version !== PIN.engine) throw Error(`Unexpected pinned engine: ${result.version}`);
  if (!result.boundsError?.includes("dimension 'z' has no coordinate array"))
    throw Error('Expected bounds failure did not reproduce; reevaluate support');
  if (result.chunkRequests.length !== 24 || result.otherPlanes.length !== 16)
    throw Error('Expected unpruned scan did not reproduce; reevaluate support');
  if (JSON.stringify(result.rows.map((row) => row.value)) !== '[111,112,121,122]')
    throw Error('Actual SQL crop values differ from format fixture');
  if (
    result.metadataVersion !== 'v1.5.4' ||
    !result.metadataExtensionError?.includes('Unsupported C CAPI version')
  )
    throw Error('Metadata runtime compatibility changed; reevaluate artifact');
  console.log(
    JSON.stringify(
      {
        supported: false,
        code: 'UNBOUNDED_OME_READ',
        pin: PIN,
        engine: result.version,
        metadataEngine: result.metadataVersion,
        cropPixels: result.rows.length,
        chunksFetched: result.chunkRequests.length,
        otherPlaneChunks: result.otherPlanes.length,
        evidence: join(root, 'audit-result.json'),
      },
      null,
      2,
    ),
  );
}

/** Explicit synthetic FORMAT fixture, not a biological dataset or mocked SQL. */
async function fixture(publicDir) {
  const root = join(publicDir, 'synthetic.zarr');
  const json = async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data));
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
  await json(join(root, '0', '.zattrs'), {});
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

const BROWSER_PROBE = `
import * as duckdb from '@duckdb/duckdb-wasm';
import wasm from '@duckdb/duckdb-wasm/dist/duckdb-base.wasm?url';
import worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url';
import * as metadataRuntime from 'duckdb-metadata-runtime';
import metadataWasm from 'duckdb-metadata-runtime/dist/duckdb-eh.wasm?url';
import metadataWorker from 'duckdb-metadata-runtime/dist/duckdb-browser-eh.worker.js?url';
window.audit = (async () => {
  const extension = location.origin + '/zarr.duckdb_extension.wasm';
  const oldDB = new metadataRuntime.AsyncDuckDB(new metadataRuntime.VoidLogger(), new Worker(metadataWorker));
  await oldDB.instantiate(metadataWasm);
  await oldDB.open({ allowUnsignedExtensions: true });
  const oldConnection = await oldDB.connect();
  const metadataVersion = (await oldConnection.query('SELECT version() AS v')).toArray()[0].v;
  let metadataExtensionError;
  try { await oldConnection.query("LOAD '" + extension + "'"); } catch(e) { metadataExtensionError = e.message; }
  await oldConnection.close(); await oldDB.terminate();
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(worker));
  await db.instantiate(wasm);
  await db.open({ allowUnsignedExtensions: true });
  const connection = await db.connect();
  const version = (await connection.query('SELECT version() AS v')).toArray()[0].v;
  await connection.query("LOAD '" + extension + "'");
  const source = location.origin + '/synthetic.zarr';
  const boundsSQL = "SELECT c,z,y,x,value FROM read_zarr('" + source + "', array_path := '0', bounds := [['z','1','1'],['y','1','2'],['x','1','2'],['c','0','0']])";
  let boundsError;
  try { await connection.query(boundsSQL); } catch(e) { boundsError = e.message; }
  const sql = "SELECT c,z,y,x,value FROM read_zarr('" + source + "', array_path := '0') WHERE c=0 AND z=1 AND y BETWEEN 1 AND 2 AND x BETWEEN 1 AND 2 ORDER BY y,x";
  const rows = (await connection.query(sql)).toArray().map(row => Object.fromEntries(Object.entries(row.toJSON()).map(([k,v]) => [k,typeof v==='bigint'?Number(v):v])));
  await connection.close(); await db.terminate();
  return { metadataVersion, metadataExtensionError, version, boundsSQL, boundsError, sql, rows };
})();
`;

const RUN_BROWSER = `
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
const server = await createServer({appType:'mpa',server:{host:'127.0.0.1',port:5198,strictPort:true}});
await server.listen();
let browser;
try {
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  const requests=[];
  page.on('request',request=>{if(request.url().includes('/synthetic.zarr/')) requests.push({url:new URL(request.url()).pathname,method:request.method()});});
  await page.goto('http://127.0.0.1:5198');
  const result = await page.evaluate(()=>window.audit);
  result.requests=requests;
  result.chunkRequests=[...new Set(requests.filter(r=>/\\/\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(r.url)).map(r=>r.url))];
  result.otherPlanes=result.chunkRequests.filter(p=>p.split('/').at(-1).split('.')[1]!=='1');
  await writeFile('audit-result.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({version:result.version,metadataVersion:result.metadataVersion,rows:result.rows,chunkCount:result.chunkRequests.length,otherPlaneChunkCount:result.otherPlanes.length},null,2));
} finally {await browser?.close();await server.close();}
`;

await main();
