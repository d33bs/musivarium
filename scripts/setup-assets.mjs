import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const target = new URL('../public/vendor/', import.meta.url);
await mkdir(target, { recursive: true });
const manifest = { generated: new Date().toISOString(), files: [] };
for (const [directory, pattern] of [
  ['@duckdb/duckdb-wasm/dist', /^(duckdb-base\.wasm|duckdb-browser-base\.worker\.js)$/],
  ['onnxruntime-web/dist', /^ort-wasm-simd-threaded\.(wasm|mjs)$/],
]) {
  const source = new URL(`../node_modules/${directory}/`, import.meta.url);
  for (const name of await readdir(source)) {
    if (!pattern.test(name)) continue;
    const bytes = await readFile(new URL(name, source));
    await copyFile(new URL(name, source), new URL(name, target));
    manifest.files.push({
      name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
}
const extensionPins = JSON.parse(
  await readFile(new URL('./runtime-assets.json', import.meta.url), 'utf8'),
);
for (const asset of extensionPins.extensions) {
  const path = new URL(asset.path, target);
  await mkdir(new URL('./', path), { recursive: true });
  let data;
  try {
    data = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const valid = (bytes) =>
    bytes?.length === asset.bytes &&
    createHash('sha256').update(bytes).digest('hex') === asset.sha256;
  if (!valid(data)) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok || !response.body)
      throw Error(`${asset.path} download: HTTP ${response.status}`);
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.byteLength;
      if (size > asset.bytes) throw Error('Extension exceeds pinned size');
      parts.push(Buffer.from(part));
    }
    data = Buffer.concat(parts);
    if (!valid(data)) throw Error(`${asset.path} SHA-256/size mismatch`);
    await writeFile(path, data);
  }
  console.log(`Verified ${asset.path} ${asset.sha256}`);
  manifest.files.push({ name: asset.path, bytes: asset.bytes, sha256: asset.sha256 });
}
await writeFile(new URL('manifest.json', target), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
const { setupModel } = await import('./setup-model.mjs');
await setupModel();
