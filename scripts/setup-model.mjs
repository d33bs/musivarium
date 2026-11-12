import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const MODEL = Object.freeze({
  name: 'StarDist DSB2018 (NEPEM-UFSC ONNX export)',
  revision: 'c1b1d0d3eb66e09904c2edcce6e0d09523743c00',
  url: 'https://huggingface.co/datasets/NEPEM-UFSC/dl_models/resolve/c1b1d0d3eb66e09904c2edcce6e0d09523743c00/stardist-dsb2018.onnx',
  sha256: '90430209afef1fbcede0b1bbd78d37e0ed9edf59cc89ef6d894356e089a5ae36',
  bytes: 5891415,
  license: 'BSD-3-Clause (StarDist); MIT (export repository)',
});

export async function setupModel(directory = resolve('public/models')) {
  await mkdir(directory, { recursive: true });
  const target = resolve(directory, 'stardist-dsb2018.onnx');
  const writeMetadata = async () => {
    await writeFile(
      resolve(directory, 'stardist-dsb2018.provenance.json'),
      `${JSON.stringify(MODEL, null, 2)}\n`,
    );
    await writeFile(
      resolve(directory, 'STARDIST-LICENSE.txt'),
      await readFile(new URL('../src/segmentation/STARDIST-LICENSE.txt', import.meta.url)),
    );
  };
  const valid = (buffer) =>
    buffer.length === MODEL.bytes &&
    createHash('sha256').update(buffer).digest('hex') === MODEL.sha256;
  try {
    if (valid(await readFile(target))) {
      await writeMetadata();
      console.log(`Verified existing ${target} (${MODEL.bytes} bytes)`);
      return target;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(MODEL.url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body)
    throw new Error(`Model download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MODEL.bytes) throw new Error('Model download exceeds pinned size');
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  if (!valid(buffer))
    throw new Error('Model size/SHA-256 verification failed; refusing to install');
  await writeFile(`${target}.part`, buffer);
  await rename(`${target}.part`, target);
  await writeMetadata();
  console.log(`Installed verified ${target} (${size} bytes; SHA-256 ${MODEL.sha256})`);
  return target;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  await setupModel(process.argv[2]);
}
