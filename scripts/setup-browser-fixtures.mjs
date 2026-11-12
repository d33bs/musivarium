import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const directory = new URL('../tests/browser/fixtures/idr0076/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
const download = process.argv.includes('--download');
const unique = new Map(manifest.entries.map((entry) => [entry.file, entry]));
await mkdir(directory, { recursive: true });
for (const entry of unique.values()) {
  let body;
  if (download) {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(30000) });
    if (response.status !== entry.status)
      throw Error(`${entry.url}: expected HTTP ${entry.status}, got ${response.status}`);
    body = Buffer.from(await response.arrayBuffer());
  } else body = await readFile(new URL(entry.file, directory));
  const hash = createHash('sha256').update(body).digest('hex');
  if (hash !== entry.sha256 || body.length !== entry.bytes)
    throw Error(`Pinned snapshot mismatch for ${entry.key}; refusing to rewrite fixture`);
  if (download) await writeFile(new URL(entry.file, directory), body);
}
console.log(
  JSON.stringify({
    mode: download ? 'download-and-verify' : 'verify-offline',
    routes: manifest.entries.length,
    uniqueBodies: unique.size,
    bytes: [...unique.values()].reduce((sum, entry) => sum + entry.bytes, 0),
    license: manifest.attribution.license,
  }),
);
