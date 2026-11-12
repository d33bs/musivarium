#!/usr/bin/env node
// Real application backends; independent SciPy matching; no source modifications.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname, platform, release, arch, cpus } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REVISION = 'e80c6de700693bc228ed3c9ba1dc19c3785667ee';
const MODEL_HASH = '90430209afef1fbcede0b1bbd78d37e0ed9edf59cc89ef6d894356e089a5ae36';
const MODEL_SIZE = 5891415;
const FIXTURES = [
  ['img2d.tif', 'e599a27b3f4edf119cd838123a8aad5fbbff459790e9849355d2027b361a3dd8'],
  ['mask2d.tif', '370583159b88e0cb4f83a17526099972d562f5a9e9fa6148ee68e73885a285e0'],
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

// Separate implementation: contingency table + cardinality-first weighted assignment.
// No application or StarDist segmentation/matching code is imported in Python.
const PYTHON = String.raw`
import sys, json, platform
from pathlib import Path
import numpy as np
import scipy
from scipy.optimize import linear_sum_assignment
import tifffile

def matching(reference, prediction):
    rids, r = np.unique(reference, return_inverse=True)
    pids, p = np.unique(prediction, return_inverse=True)
    table = np.bincount(r.astype(np.int64)*len(pids)+p, minlength=len(rids)*len(pids)).reshape(len(rids),len(pids))
    ri, pi = np.flatnonzero(rids != 0), np.flatnonzero(pids != 0)
    intersection = table[np.ix_(ri,pi)]
    union = table.sum(axis=1)[ri,None] + table.sum(axis=0)[None,pi] - intersection
    iou = np.divide(intersection, union, out=np.zeros_like(intersection,dtype=float), where=union>0)
    nref, npred = len(ri), len(pi)
    pairs = []
    if nref and npred:
        # At most min(nref,npred) secondary terms, whose sum is strictly <1.
        # Thus losing an eligible match can never improve the objective.
        score = (iou >= 0.5).astype(float) * (1 + iou/(min(nref,npred)+1))
        rows, cols = linear_sum_assignment(score, maximize=True)
        pairs = [dict(reference=int(rids[ri[a]]), prediction=int(pids[pi[b]]), iou=float(iou[a,b]))
                 for a,b in zip(rows,cols) if iou[a,b]>=0.5]
    tp = len(pairs)
    fg_intersection = int(np.count_nonzero((reference>0)&(prediction>0)))
    fg_union = int(np.count_nonzero((reference>0)|(prediction>0)))
    return dict(reference_instances=nref, predicted_instances=npred, tp=tp, fp=npred-tp, fn=nref-tp,
                precision=tp/npred if npred else 0., recall=tp/nref if nref else 0.,
                f1=2*tp/(npred+nref) if npred+nref else 0.,
                foreground_iou=fg_intersection/fg_union if fg_union else 1., matched_pairs=pairs)

cases = [
    ([0,4,4,0,8,8],[0,1,1,0,2,2],(2,0,0)),
    ([1,1,1,1],[3,3,4,4],(1,1,0)),  # split: two IoU==0.5 candidates, one match
    ([1,1,2,2],[3,3,3,3],(1,0,1)),  # merge: two IoU==0.5 candidates, one match
    ([1,1,0,0],[0,0,2,2],(0,1,1)),
    ([0,0],[0,0],(0,0,0)),
    ([1,1,0],[0,0,0],(0,0,1)),
    ([0,0,0],[2,2,0],(0,1,0)),
    ([1,1,1,0],[2,0,0,2],(0,1,1)),  # below threshold
]
for ref,pred,expected in cases:
    m=matching(np.asarray(ref),np.asarray(pred))
    assert (m['tp'],m['fp'],m['fn'])==expected, (m,expected)
mode=sys.argv[1]
versions=dict(python=platform.python_version(), numpy=np.__version__, scipy=scipy.__version__, tifffile=tifffile.__version__)
if mode=='self-test':
    print(json.dumps(dict(cases_passed=len(cases), versions=versions)))
else:
    d=Path(sys.argv[2])
    if mode=='prepare':
        image=tifffile.imread(d/'img2d.tif')
        labels=tifffile.imread(d/'mask2d.tif')
        assert image.shape==labels.shape==(256,256), (image.shape, labels.shape)
        assert np.isfinite(image).all() and np.issubdtype(labels.dtype,np.integer) and labels.min()>=0
        image.astype('<f4').tofile(d/'image.f32')
        labels.astype('<u4').tofile(d/'labels.u32')
        assert len(np.unique(labels[labels>0]))==65
        print(json.dumps(dict(shape=list(image.shape), original_image_dtype=str(image.dtype), original_label_dtype=str(labels.dtype), versions=versions)))
    elif mode=='evaluate':
        ref=np.fromfile(d/'labels.u32',dtype='<u4')
        results={name:matching(ref,np.fromfile(d/(name+'.u32'),dtype='<u4')) for name in ['model','classical']}
        print(json.dumps(dict(results=results, versions=versions, self_test_cases_passed=len(cases))))
    else:
        raise ValueError('Unknown mode: '+mode)
`;

function python(mode, directory) {
  const result = spawnSync(
    process.env.PYTHON ?? 'python',
    ['-c', PYTHON, mode, ...(directory ? [directory] : [])],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Python ${mode} failed; install numpy scipy tifffile in PYTHON.\n${result.error ?? result.stderr}`,
    );
  return JSON.parse(result.stdout);
}

// Independent JS maximum-cardinality bipartite matching (augmenting paths).
// SciPy additionally uses total IoU to break cardinality ties.
function instanceCounts(reference, prediction) {
  assert.equal(reference.length, prediction.length);
  const rarea = new Map(),
    parea = new Map(),
    overlap = new Map();
  for (let i = 0; i < reference.length; i++) {
    const r = reference[i],
      p = prediction[i];
    if (r) rarea.set(r, (rarea.get(r) ?? 0) + 1);
    if (p) parea.set(p, (parea.get(p) ?? 0) + 1);
    if (r && p) {
      const key = `${r}:${p}`;
      overlap.set(key, (overlap.get(key) ?? 0) + 1);
    }
  }
  const adjacency = new Map([...rarea.keys()].map((r) => [r, []]));
  for (const [key, intersection] of overlap) {
    const [r, p] = key.split(':').map(Number);
    if (intersection / (rarea.get(r) + parea.get(p) - intersection) >= 0.5)
      adjacency.get(r).push(p);
  }
  const owner = new Map();
  function augment(r, seen) {
    for (const p of adjacency.get(r)) {
      if (seen.has(p)) continue;
      seen.add(p);
      if (!owner.has(p) || augment(owner.get(p), seen)) {
        owner.set(p, r);
        return true;
      }
    }
    return false;
  }
  for (const r of adjacency.keys()) augment(r, new Set());
  return { tp: owner.size, fp: parea.size - owner.size, fn: rarea.size - owner.size };
}

async function fixture(directory, filename, expected, download) {
  const path = join(directory, filename);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT' || !download) throw error;
    const url = `https://raw.githubusercontent.com/stardist/stardist/${REVISION}/tests/data/${filename}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body)
      throw new Error(`Fixture download: HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Fixture download exceeds 2 MiB');
      chunks.push(Buffer.from(chunk));
    }
    bytes = Buffer.concat(chunks);
    assert.equal(hash(bytes), expected, `${filename}: SHA-256 mismatch; refusing to save`);
    await writeFile(path, bytes, { flag: 'wx' });
  }
  assert.equal(hash(bytes), expected, `${filename}: SHA-256 mismatch; refusing to benchmark`);
  return { file: filename, bytes: bytes.length, sha256: expected };
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set([
    '--directory',
    '--download',
    '--repeats',
    '--model-file',
    '--self-test',
    '--help',
  ]);
  for (let i = 0; i < args.length; i++) {
    assert(allowed.has(args[i]), `Unknown option: ${args[i]}`);
    if (['--directory', '--repeats', '--model-file'].includes(args[i]))
      assert(args[++i] && !args[i].startsWith('--'), 'Missing option value');
  }
  const value = (option) => {
    const at = args.indexOf(option);
    return at < 0 ? undefined : args[at + 1];
  };
  if (args.includes('--help')) {
    console.log(
      'node scripts/benchmark-segmentation.mjs --directory /scratch/path [--download] [--repeats 5] [--model-file path]\nPYTHON selects Python with numpy, scipy, tifffile. Node >=22.18 required. --self-test needs no weights. Model overrides must match the pinned size AND hash.',
    );
    return;
  }
  const selfTest = python('self-test');
  for (const [r, p, expected] of [
    [[0, 4, 4, 0, 8, 8], [0, 1, 1, 0, 2, 2], { tp: 2, fp: 0, fn: 0 }],
    [[1, 1, 1, 1], [3, 3, 4, 4], { tp: 1, fp: 1, fn: 0 }],
    [[1, 1, 2, 2], [3, 3, 3, 3], { tp: 1, fp: 0, fn: 1 }],
    [[1, 1, 0, 0], [0, 0, 2, 2], { tp: 0, fp: 1, fn: 1 }],
    [[0, 0], [0, 0], { tp: 0, fp: 0, fn: 0 }],
    [[1, 1, 0], [0, 0, 0], { tp: 0, fp: 0, fn: 1 }],
    [[0, 0, 0], [2, 2, 0], { tp: 0, fp: 1, fn: 0 }],
    [[1, 1, 1, 0], [2, 0, 0, 2], { tp: 0, fp: 1, fn: 1 }],
  ])
    assert.deepEqual(instanceCounts(r, p), expected);
  if (args.includes('--self-test')) {
    console.log(JSON.stringify({ javascript_cases_passed: 8, python: selfTest }, null, 2));
    return;
  }
  const directoryArg = value('--directory') ?? process.env.SEGMENTATION_BENCHMARK_DIR;
  assert(directoryArg, 'Pass --directory or SEGMENTATION_BENCHMARK_DIR (scratch output directory)');
  const directory = resolve(directoryArg),
    repeats = Number(value('--repeats') ?? 5);
  assert(
    Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 100,
    '--repeats must be 1..100',
  );
  await mkdir(directory, { recursive: true });
  const modelPath = value('--model-file')
    ? resolve(value('--model-file'))
    : join(ROOT, 'public/models/stardist-dsb2018.onnx');
  const model = await readFile(modelPath);
  assert.equal(model.length, MODEL_SIZE, 'Pinned model size mismatch');
  assert.equal(hash(model), MODEL_HASH, 'Pinned model SHA-256 mismatch');
  const fixtureEvidence = await Promise.all(
    FIXTURES.map(([name, sha]) => fixture(directory, name, sha, args.includes('--download'))),
  );
  const prepared = python('prepare', directory);
  const imageBuffer = await readFile(join(directory, 'image.f32'));
  const referenceBuffer = await readFile(join(directory, 'labels.u32'));
  assert.equal(imageBuffer.length, 256 * 256 * 4);
  assert.equal(referenceBuffer.length, imageBuffer.length);
  const pixels = new Float32Array(256 * 256),
    reference = new Uint32Array(256 * 256);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = imageBuffer.readFloatLE(i * 4);
    reference[i] = referenceBuffer.readUInt32LE(i * 4);
  }
  const sourcePath = join(ROOT, 'src/segmentation/index.ts');
  const sourceHash = hash(await readFile(sourcePath));
  const { segmentModel, segmentClassical, MODEL_INFO } = await import(
    pathToFileURL(sourcePath).href
  );
  assert.equal(MODEL_INFO.sha256, MODEL_HASH);
  assert.equal(MODEL_INFO.bytes, MODEL_SIZE);
  const importStart = performance.now();
  const ort = await import('onnxruntime-web/wasm');
  const runtimeImportMs = performance.now() - importStart;
  const sessionCreations = [],
    graphRuns = [],
    sessions = [];
  const originalCreate = ort.InferenceSession.create;
  const tensorInfo = (tensor) => ({
    dims: [...tensor.dims],
    type: tensor.type,
    bytes: tensor.data.byteLength,
  });
  ort.InferenceSession.create = async function (...parameters) {
    const start = performance.now();
    const session = await originalCreate.apply(this, parameters);
    sessionCreations.push(performance.now() - start);
    sessions.push(session);
    const originalRun = session.run.bind(session);
    session.run = async function (feeds, ...rest) {
      const startRun = performance.now();
      const outputs = await originalRun(feeds, ...rest);
      const ms = performance.now() - startRun;
      graphRuns.push({
        ms,
        inputs: Object.fromEntries(Object.entries(feeds).map(([k, t]) => [k, tensorInfo(t)])),
        outputs: Object.fromEntries(Object.entries(outputs).map(([k, t]) => [k, tensorInfo(t)])),
      });
      return outputs;
    };
    return session;
  };
  // The actual app's fetch/checksum/session-cache path, using local verified weights.
  const server = createServer((request, response) => {
    if (request.url !== '/stardist.onnx') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': model.length,
    });
    response.end(model);
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  try {
    const modelUrl = `http://127.0.0.1:${server.address().port}/stardist.onnx`;
    const times = { model: [], classical: [] },
      labelHashes = { model: [], classical: [] };
    let learned, classical;
    // First-observed call plus N cached-session calls; alternate order each round.
    for (let round = 0; round <= repeats; round++) {
      for (const name of round % 2 ? ['classical', 'model'] : ['model', 'classical']) {
        const start = performance.now();
        const labels =
          name === 'model'
            ? await segmentModel(pixels, 256, 256, { minArea: 8, modelUrl })
            : segmentClassical(pixels, 256, 256, { minArea: 8 });
        times[name].push(performance.now() - start);
        assert(labels instanceof Uint32Array);
        assert.equal(labels.length, pixels.length);
        labelHashes[name].push(hash(bytesOf(labels)));
        if (name === 'model') learned = labels;
        else classical = labels;
      }
    }
    for (const hashes of Object.values(labelHashes))
      assert.equal(new Set(hashes).size, 1, 'Repeated label bytes differ');
    assert.equal(
      hash(bytesOf(pixels)),
      hash(imageBuffer),
      'Input was mutated (little-endian host required)',
    );
    assert.equal(sessionCreations.length, 1, 'Warm runs must reuse the actual app session');
    assert.equal(graphRuns.length, repeats + 1, 'Every model run must execute the actual graph');
    for (const run of graphRuns) {
      assert.deepEqual(run.inputs.keras_tensor, {
        dims: [1, 256, 256, 1],
        type: 'float32',
        bytes: 262144,
      });
      assert.deepEqual(run.outputs.prob, { dims: [1, 128, 128, 1], type: 'float32', bytes: 65536 });
      assert.deepEqual(run.outputs.dist, {
        dims: [1, 128, 128, 48],
        type: 'float32',
        bytes: 3145728,
      });
    }
    await writeFile(join(directory, 'model.u32'), bytesOf(learned));
    await writeFile(join(directory, 'classical.u32'), bytesOf(classical));
    const evaluation = python('evaluate', directory);
    for (const [name, labels] of [
      ['model', learned],
      ['classical', classical],
    ]) {
      const independentJS = instanceCounts(reference, labels),
        scipy = evaluation.results[name];
      assert.deepEqual(
        independentJS,
        { tp: scipy.tp, fp: scipy.fp, fn: scipy.fn },
        'Independent JS/SciPy matching disagreement',
      );
    }
    assert.equal(
      hash(await readFile(sourcePath)),
      sourceHash,
      'Source changed during benchmark; rerun',
    );
    const median = (values) => {
      const s = [...values].sort((a, b) => a - b),
        m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const n = pixels.length,
      graph = graphRuns[0];
    const namedPayloads = {
      source_image: pixels.byteLength,
      normalized_image: n * 4,
      padded_graph_input: graph.inputs.keras_tensor.bytes,
      graph_probability_output: graph.outputs.prob.bytes,
      graph_distance_output: graph.outputs.dist.bytes,
      packed_decoder_input: graph.outputs.prob.bytes + graph.outputs.dist.bytes,
      result_labels: learned.byteLength,
    };
    const result = {
      schema: 1,
      measured_at: new Date().toISOString(),
      scope:
        'Single public 256x256 StarDist test fixture; smoke comparison, NOT held-out evaluation',
      environment: {
        node: process.version,
        platform: platform(),
        os_release: release(),
        architecture: arch(),
        cpu: cpus()[0]?.model,
        hostname: hostname(),
        onnxruntime_web: JSON.parse(
          await readFile(join(ROOT, 'node_modules/onnxruntime-web/package.json'), 'utf8'),
        ).version,
        execution_provider: 'wasm',
        threads: ort.env.wasm.numThreads,
        python: evaluation.versions,
      },
      identity: {
        source_sha256: sourceHash,
        script_sha256: hash(await readFile(fileURLToPath(import.meta.url))),
        model_sha256: MODEL_HASH,
        model_bytes: MODEL_SIZE,
        fixture_revision: REVISION,
        fixtures: fixtureEvidence,
        image_f32_sha256: hash(imageBuffer),
        reference_u32_sha256: hash(referenceBuffer),
        prediction_u32_sha256: Object.fromEntries(
          Object.entries(labelHashes).map(([k, v]) => [k, v[0]]),
        ),
      },
      fixture: prepared,
      settings: {
        minArea: 8,
        model_probability_threshold: 0.5,
        classical_threshold: 'default Otsu',
        matching_iou: 0.5,
        matching:
          'maximum eligible cardinality, then maximum sum IoU (SciPy); JS independently verifies cardinality',
      },
      quality: evaluation.results,
      timing: {
        units: 'ms',
        runtime_module_import_ms: runtimeImportMs,
        session_creation_ms: sessionCreations,
        graph_runs: graphRuns,
        backends: Object.fromEntries(
          Object.entries(times).map(([name, samples]) => [
            name,
            {
              first_call_ms: samples[0],
              subsequent_call_ms: samples.slice(1),
              subsequent_median_ms: median(samples.slice(1)),
            },
          ]),
        ),
        note: 'Node WASM CPU, not browser timing. First call includes local HTTP model fetch, checksum and new WASM/session setup (ORT module import excluded); subsequent calls use one cached session. Backend times include normalization/graph/decoding or Otsu/components; scoring and file I/O excluded.',
      },
      logical_memory: {
        units: 'bytes',
        model_named_payloads: namedPayloads,
        model_named_payload_sum: Object.values(namedPayloads).reduce((a, b) => a + b, 0),
        serialized_model_file: model.length,
        reference_mask_scoring_only: reference.byteLength,
        transient_percentile_sort_copy: n * 4,
        classical_named_payloads: {
          source_image: pixels.byteLength,
          result_labels: classical.byteLength,
          component_queue: n * 4,
          visited: n,
          otsu_histogram: 256 * 4,
        },
        classical_named_payload_sum: pixels.byteLength + classical.byteLength + n * 4 + n + 256 * 4,
        evidence:
          'Input/output and returned-label byteLength measured on real tensors; normalized/packed/sort/queue/visited/histogram sizes derived from inspected source allocations. Sum is logical named array payload, NOT measured peak/live residency, browser RSS, JS heap or WASM linear memory. Excludes ORT weights/activations/arena/workspaces and decoder JS arrays/objects; model file is serialized bytes, not resident tensor memory. Histogram/sort need not coexist with later arrays.',
      },
      verification: {
        independent_js_scipy_counts_agree: true,
        python_self_test_cases: evaluation.self_test_cases_passed,
        javascript_self_test_cases: 8,
        repeated_label_hashes_identical: true,
        input_unmodified: true,
        graph_calls: graphRuns.length,
        sessions_created: sessionCreations.length,
      },
    };
    await writeFile(join(directory, 'benchmark.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    ort.InferenceSession.create = originalCreate;
    await Promise.all(sessions.map((session) => session.release()));
    await new Promise((accept) => server.close(accept));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
