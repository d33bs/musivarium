import './style.css';
import { parseView, withView, DEFAULT_VIEW, type ViewSettings } from './view';
import {
  DEFAULT_SETTINGS,
  parseSettings,
  settingsUrl,
  validateSettings,
  type Settings,
} from './core';
import type { Cell, RunResult, Progress } from './pipeline';
import type { NgffMetadata, Alignment } from './sources/browser';
import type { NetworkProgress } from './sources/read-session';
import { drawCrop, seededOrder } from './render';
import { download, cropArchive, provenance } from './exports';
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
$('#app').innerHTML = `
<header class="topbar"><a class="wordmark" href="./">musivarium<span class="mark" aria-hidden="true">▦</span></a><button id="about-toggle" type="button" class="about-toggle"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.3"></circle><circle cx="8" cy="4.7" r="0.9" fill="currentColor"></circle><path d="M8 7.2v4.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path></svg>About</button><a class="source-link" href="https://github.com/d33bs/musivarium" target="_blank" rel="noopener"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"></path></svg>Source</a></header>
<main class="settings-collapsed"><aside id="controls-panel" class="controls" hidden><div class="controls-heading"><button id="close-settings" type="button" class="secondary" aria-label="Hide settings">Hide ×</button></div>
<form id="settings"><label for="preset">Sample dataset</label><select id="preset"><option value="labels">IDR0076 · verified cell labels</option><option value="idr0033">IDR0033 · supplied source</option><option value="custom">Your OME-Zarr image</option></select>
<label for="source">OME-Zarr image-group URL</label><input id="source" name="source" type="url" required spellcheck="false"><p class="hint">An image group, not a plate or array. Direct HTTPS reads; no server upload.</p>
<button type="button" id="inspect" class="secondary full">Inspect metadata</button><div id="metadata" class="metadata" hidden></div>
<div class="two"><div><label for="reader">Image reader</label><select id="reader"><option value="browser">Browser · Zarrita</option><option value="duckdb-zarr" disabled>DuckDB-Zarr · blocked: unbounded reads</option></select></div><div><label for="segmentation">Find objects with</label><select id="segmentation"><option value="classical">Classical baseline</option><option value="model">Pretrained nuclei model</option><option value="labels">Existing labels</option></select></div></div>
<p id="backend-note" class="hint">Threshold + connected components. A baseline, not validated cell segmentation.</p>
<div id="label-field" hidden><label for="labelPath">Label group name or HTTPS URL</label><input id="labelPath" placeholder="Auto-detect from image labels" spellcheck="false"></div>
<div class="three"><div><label for="level">Level</label><input id="level" type="number" min="0" max="12" step="1"></div><div><label for="t">Time index</label><input id="t" type="number" min="0" step="1"></div><div><label for="z">Z index</label><input id="z" type="number" min="0" step="1"></div></div>
<p class="plane-note">Exactly one Z slice. No volume. No projection.</p>
<div class="two"><div><label for="channels">Display channels</label><input id="channels" pattern="[0-9]+(,[0-9]+)*" placeholder="0,1,2"></div><div><label for="segmentChannel">Segment channel</label><input id="segmentChannel" type="number" min="0" step="1"></div></div><div id="channel-legend" class="channel-legend"></div>
<div class="section-label sampling-label">02 / SAMPLE</div><div class="two"><div><label for="tile">Tile width / height</label><select id="tile"><option value="128">128 px</option><option value="256">256 px</option><option value="512">512 px</option></select></div><div><label for="count">Tile budget / max</label><input id="count" type="number" min="1" max="32"></div></div>
<label for="target">Objects to collect</label><input id="target" type="number" min="1" max="1000"><div class="seed-row"><div><label for="seed">Random seed</label><input id="seed" maxlength="128"></div><button type="button" id="new-seed" class="secondary" aria-label="Choose a new random seed">↻</button></div>
<details class="advanced"><summary>Object limits & crop padding</summary><div class="three"><div><label for="minArea">Min area / px²</label><input id="minArea" type="number" min="0"></div><div><label for="maxArea">Max area / px²</label><input id="maxArea" type="number" min="0"></div><div><label for="padding">Padding / px</label><input id="padding" type="number" min="0" max="64"></div></div><div class="three"><div><label for="cropSize">Crop min / px</label><input id="cropSize" type="number" min="8" max="256"></div><div><label for="modelThreshold">Model probability</label><input id="modelThreshold" type="number" min="0" max="1" step="0.05"></div><div><label for="classicalThreshold">Raw threshold</label><input id="classicalThreshold" placeholder="Auto Otsu" type="number" step="any"></div></div><label class="check"><input id="excludeEdges" type="checkbox"> Exclude tile-edge objects</label><p class="hint">Edge objects may be incomplete. Measurements use original native intensities, not display colors.</p></details>
<div class="run-actions"><button id="run" type="submit" class="primary">Sample objects</button></div></form>
<div class="section-label display-label">03 / DISPLAY</div>
<div class="two"><div><label for="sort">Order</label><select id="sort"><option value="random">Seeded shuffle</option><option value="area-desc">Largest area first</option><option value="area-asc">Smallest area first</option><option value="intensity">Brightest first</option></select></div><div><label for="filter-area">Min area</label><input id="filter-area" type="number" min="0" value="0"></div></div>
<div class="two"><div><label for="filter-intensity">Min mean</label><input id="filter-intensity" type="number" value="0"></div><div><label for="contrast">Contrast</label><select id="contrast"><option value="auto">Per-crop percentile</option><option value="fixed">Fixed raw window</option></select></div></div>
<div class="two"><div><label for="display-low">Low</label><input id="display-low" type="number" value="0" step="any"></div><div><label for="display-high">High</label><input id="display-high" type="number" value="25000" step="any"></div></div>
<label for="size">Crop size</label><input id="size" type="range" min="72" max="180" value="112">
<div class="two"><label class="check"><input id="overlay" type="checkbox"> Outlines</label><label class="check"><input id="context" type="checkbox" checked> Context</label></div>
</aside>
<section class="workspace" aria-label="Object mosaic"><div class="mosaic-header"><div class="mosaic-actions"><button id="controls-toggle" type="button" class="secondary" aria-controls="controls-panel" aria-expanded="false">Show settings</button><button id="shuffle" type="button" class="primary">Shuffle & sample</button><button id="cancel" type="button" class="secondary" disabled>Cancel</button><button id="share" class="secondary">Copy reproducible link</button></div></div>
<div id="status" class="status" role="status" aria-live="polite" hidden></div><div id="reading-progress" class="reading-progress" hidden><div class="reading-heading"><span>Image / label transfer</span><span id="read-elapsed">0.0 s</span></div><progress id="progress" max="1" aria-label="Image and label download progress" aria-describedby="read-summary" title="Download totals cover discovered requests, not an estimated overall job size"></progress><div id="read-summary" class="read-summary">Waiting for the source…</div><div id="read-file" class="read-file"></div></div>
<div id="metrics" class="metrics" hidden></div><div id="warnings" class="warnings" hidden></div>
<div class="result-count" id="result-count" role="status" aria-live="polite">No objects sampled yet</div>
<div id="mosaic-scroll" class="mosaic-scroll" tabindex="0" aria-label="Scrollable single-object mosaic"><div id="empty" class="empty"><span class="empty-glyph" aria-hidden="true">▦</span><p>Small samples.<br>Unexpected details.</p><span>Choose a source, a plane, and a seed.</span></div><div id="mosaic" role="grid" aria-label="Single-object image crops"></div></div>
<div class="mosaic-caption">Each tile is one object-centered crop, shown in grayscale with a green outline on the focused instance. Click or press Enter to inspect. Display contrast is per crop; means are measured on raw pixels.</div>
<p class="credit" id="credit">Default: IDR0076, Ali et al., CC BY 4.0. Verified 2D tissue cell labels. Display override: channel 42, DNA1-191Ir. Images hosted by IDR / EMBL-EBI.</p><div class="export-row"><span>Export this view</span><button id="csv" class="secondary" disabled>CSV</button><button id="parquet" class="secondary" disabled>Parquet</button><button id="raw" class="secondary" disabled>Native crops ZIP</button><button id="mosaic-png" class="secondary" disabled>Mosaic PNG</button><button id="manifest" class="secondary" disabled>Run JSON</button></div>
<pre id="run-details" hidden>No run yet.</pre></section></main>
<dialog id="about"><div class="dialog-head"><h2>About</h2><button id="close-about" class="secondary" aria-label="Close about dialog">Close ×</button></div><p>musivarium samples single-plane, single-object crops from large OME-NGFF / IDR microscopy images, directly in the browser. No image data is uploaded to a server.</p><ul class="about-tech"><li><a href="https://ngff.openmicroscopy.org/" target="_blank" rel="noopener">OME-NGFF / OME-Zarr</a> — the chunked, cloud-native image format read here.</li><li><a href="https://github.com/manzt/zarrita.js" target="_blank" rel="noopener">zarrita</a> — browser-native Zarr v2/v3 reader.</li><li><a href="https://duckdb.org/docs/api/wasm/overview" target="_blank" rel="noopener">DuckDB-WASM</a> — local SQL engine behind the CSV/Parquet export.</li><li><a href="https://onnxruntime.ai/docs/tutorials/web/" target="_blank" rel="noopener">ONNX Runtime Web</a> — runs the pretrained StarDist nuclei model client-side.</li><li><a href="https://github.com/101arrowz/fflate" target="_blank" rel="noopener">fflate</a> — native-crop ZIP archive export.</li><li><a href="https://vite.dev/" target="_blank" rel="noopener">Vite</a> + <a href="https://www.typescriptlang.org/" target="_blank" rel="noopener">TypeScript</a> — build tooling and app code.</li></ul><p class="hint">Source: <a href="https://github.com/d33bs/musivarium" target="_blank" rel="noopener">github.com/d33bs/musivarium</a></p></dialog>
<dialog id="inspector"><div class="dialog-head"><h2>Object inspector</h2><button id="close" class="secondary" aria-label="Close object inspector">Close ×</button></div><div class="inspector-grid"><div><canvas id="inspector-canvas" aria-label="Selected object crop"></canvas><p class="hint">One plane, native pixel aspect ratio.</p><button id="crop-png" class="secondary">Save preview PNG</button></div><div><h3 id="object-title"></h3><dl id="object-fields"></dl><canvas id="origin" width="320" height="220" aria-label="Source coordinate map"></canvas><p class="hint">Source-coordinate map, not a whole-image download. Boxes mark sampled regions.</p><a id="source-link" target="_blank" rel="noopener">Open source in NGFF validator ↗</a></div></div></dialog>`;
let settings: Settings;
let initialSettingsValid = true;
try {
  settings = parseSettings(location.href);
} catch (e) {
  initialSettingsValid = false;
  settings = { ...DEFAULT_SETTINGS };
  setStatus(String(e), true);
}
const hiddenChannels = new Set<number>();
let result: RunResult | undefined,
  visible: Cell[] = [],
  selected: Cell | undefined,
  worker: Worker | undefined,
  generation = 0,
  dbReady = false,
  gridFrame = 0,
  runStarted = 0,
  firstBatchMs = 0,
  running = false;
function setStatus(text: string, error = false) {
  $('#status').textContent = text;
  $('#status').hidden = !text;
  $('#status').classList.toggle('error', error);
}
function readView(): ViewSettings {
  return {
    sort: select('sort').value as ViewSettings['sort'],
    area: Number(input('filter-area').value) || 0,
    mean: Number(input('filter-intensity').value) || 0,
    overlay: input('overlay').checked,
    context: input('context').checked,
    size: Number(input('size').value),
    contrast: select('contrast').value as ViewSettings['contrast'],
    low: Number(input('display-low').value),
    high: Number(input('display-high').value),
    hiddenChannels: [...hiddenChannels],
  };
}
function input(id: string) {
  return $<HTMLInputElement>(`#${id}`);
}
function select(id: string) {
  return $<HTMLSelectElement>(`#${id}`);
}
function button(id: string) {
  return $<HTMLButtonElement>(`#${id}`);
}
function fill(s: Settings) {
  for (const [key, value] of Object.entries(s)) {
    const element = document.getElementById(key) as HTMLInputElement;
    if (!element) continue;
    if (typeof value === 'boolean') element.checked = value;
    else element.value = Array.isArray(value) ? value.join(',') : String(value);
  }
  backendNote();
}
function readSettings(): Settings {
  const s = { ...settings };
  for (const key of Object.keys(s) as (keyof Settings)[]) {
    const element = document.getElementById(key) as HTMLInputElement;
    if (!element) continue;
    const v = element.value.trim();
    if (key === 'channels') s.channels = v.split(',').map(Number);
    else if (typeof s[key] === 'boolean')
      (s as unknown as Record<string, unknown>)[key] = element.checked;
    else if (typeof s[key] === 'number') (s as unknown as Record<string, unknown>)[key] = Number(v);
    else (s as unknown as Record<string, unknown>)[key] = v;
  }
  return validateSettings(s);
}
function backendNote() {
  const backend = select('segmentation').value;
  $('#label-field').hidden = backend !== 'labels';
  $('#backend-note').textContent =
    backend === 'labels'
      ? 'Instance IDs must align with the selected image level and plane.'
      : backend === 'model'
        ? 'A pretrained 2D nuclei model. Nuclei are not whole-cell boundaries.'
        : 'Threshold + connected components. A baseline, not validated cell segmentation.';
}
function setSettingsOpen(open: boolean) {
  const panel = $('#controls-panel'),
    toggle = button('controls-toggle');
  panel.hidden = !open;
  $('main').classList.toggle('settings-collapsed', !open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? 'Hide settings' : 'Show settings';
  if (open) select('preset').focus();
  else toggle.focus();
}
button('controls-toggle').onclick = () => setSettingsOpen($('#controls-panel').hidden);
button('close-settings').onclick = () => setSettingsOpen(false);
button('about-toggle').onclick = () => $<HTMLDialogElement>('#about').showModal();
button('close-about').onclick = () => $<HTMLDialogElement>('#about').close();
fill(settings);
try {
  const v = parseView(location.href);
  select('sort').value = v.sort;
  input('filter-area').value = String(v.area);
  input('filter-intensity').value = String(v.mean);
  input('overlay').checked = v.overlay;
  input('context').checked = v.context;
  input('size').value = String(v.size);
  select('contrast').value = v.contrast;
  input('display-low').value = String(v.low);
  input('display-high').value = String(v.high);
  v.hiddenChannels.forEach((c) => hiddenChannels.add(c));
} catch (e) {
  initialSettingsValid = false;
  setStatus(`Invalid display state: ${e instanceof Error ? e.message : e}`, true);
}
select('preset').value =
  settings.source === DEFAULT_SETTINGS.source
    ? 'labels'
    : settings.source.includes('idr0033A')
      ? 'idr0033'
      : 'custom';
select('segmentation').onchange = backendNote;
button('new-seed').onclick = () => {
  input('seed').value = crypto.getRandomValues(new Uint32Array(1))[0].toString();
};
select('preset').onchange = () => {
  const choice = select('preset').value;
  if (choice === 'custom') {
    input('source').focus();
    return;
  }
  settings = {
    ...DEFAULT_SETTINGS,
    ...(choice === 'idr0033'
      ? {
          source: 'https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/',
          segmentation: 'model' as const,
          labelPath: '',
          channels: [0, 1, 2],
          segmentChannel: 0,
          cropSize: 64,
        }
      : { channels: [42] }),
  };
  $('#credit').textContent =
    choice === 'labels'
      ? 'IDR0076, Ali et al., CC BY 4.0. Verified 2D tissue cell labels. Display override: channel 42, DNA1-191Ir.'
      : 'Supplied IDR0033 Cell Painting image. Nuclei model, not whole-cell boundaries. Already 2D; Z and time indices are zero.';
  fill(settings);
  $('#metadata').hidden = true;
  $('#channel-legend').replaceChildren();
  start('run');
};
let readNetwork: NetworkProgress | undefined;
let readingTimer: ReturnType<typeof setInterval> | undefined;
function byteText(bytes: number) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(2)} MiB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${bytes} B`;
}
function renderReadingProgress() {
  if (!running) return;
  $('#read-elapsed').textContent = `${((performance.now() - runStarted) / 1000).toFixed(1)} s`;
  const bar = $<HTMLProgressElement>('#progress'),
    p = readNetwork;
  if (!p) {
    bar.removeAttribute('value');
    $('#read-summary').textContent = 'Waiting for the source…';
    $('#read-file').textContent = '';
    return;
  }
  const known = p.totalBytes !== null && p.totalBytes > 0 && p.totalBytes >= p.receivedBytes;
  if ((p.active || p.queued) && known) bar.value = p.receivedBytes / p.totalBytes!;
  else bar.removeAttribute('value');
  const summary = `${byteText(p.receivedBytes)} received${known ? ` / ${byteText(p.totalBytes!)} discovered` : ''} · ${p.active} active · ${p.queued} queued · ${p.completed} requests finished${p.retries ? ` · ${p.retries} retries` : ''}`;
  $('#read-summary').textContent = summary;
  bar.setAttribute('aria-valuetext', summary);
  $('#read-file').textContent = p.files
    .map((url) => new URL(url).pathname.split('/').slice(-4).join('/'))
    .join(' · ');
}
function busy(value: boolean) {
  running = value;
  button('run').disabled = value;
  button('inspect').disabled = value;
  button('cancel').disabled = !value;
  button('shuffle').disabled = value;
  $('#progress').hidden = !value;
  $('#reading-progress').hidden = !value;
  if (readingTimer !== undefined) {
    clearInterval(readingTimer);
    readingTimer = undefined;
  }
  if (value) {
    renderReadingProgress();
    readingTimer = setInterval(renderReadingProgress, 200);
  }
}
function stop(terminate = true) {
  generation++;
  if (terminate) {
    worker?.terminate();
    worker = undefined;
  }
  busy(false);
}
button('cancel').onclick = () => {
  stop();
  clearResults();
  setStatus('Cancelled. No partial run was published.');
};
button('shuffle').onclick = () => {
  button('new-seed').click();
  start('run');
};
function displayMetadata(
  metadata: NgffMetadata,
  alignment: Alignment,
  dtype?: string,
  chunks?: number[],
) {
  const dims = alignment.axes.map((name, i) => `${name} ${alignment.shape[i]}`).join(' · ');
  $('#metadata').textContent =
    `${dims}\n${metadata.levels.length} levels · NGFF ${metadata.version}${dtype ? ` · ${dtype}` : ''}${chunks ? `\nChunks: ${chunks.join(' × ')}` : ''}`;
  $('#metadata').hidden = false;
  for (const name of ['t', 'z']) {
    const i = alignment.axes.indexOf(name);
    input(name).max = String(i < 0 ? 0 : alignment.shape[i] - 1);
  }
  input('level').max = String(metadata.levels.length - 1);
  const legend = $('#channel-legend');
  legend.replaceChildren();
  metadata.channels.forEach((channel, i) => {
    if (!settings.channels.includes(i)) return;
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = !hiddenChannels.has(i);
    toggle.setAttribute('aria-label', `Display channel ${i} ${channel.name}`);
    toggle.onchange = () => {
      if (toggle.checked) hiddenChannels.delete(i);
      else hiddenChannels.add(i);
      renderGrid();
      if (selected) drawInspector();
    };
    const span = document.createElement('span'),
      swatch = document.createElement('i');
    swatch.style.background = '#FFFFFF';
    span.title = `${channel.name}: grayscale display; source metadata color #${channel.color}`;
    span.append(toggle, swatch, `${i} · ${channel.name}`);
    legend.append(span);
  });
}
function start(action: 'run' | 'inspect') {
  let s: Settings;
  try {
    s = readSettings();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
    return;
  }
  stop(running);
  runStarted = performance.now();
  firstBatchMs = 0;
  readNetwork = undefined;
  settings = s;
  history.replaceState(null, '', withView(settingsUrl(settings, location.href), readView()));
  busy(true);
  const id = ++generation;
  setStatus(
    action === 'inspect'
      ? 'Reading source metadata…'
      : 'Opening image. Only requested plane tiles will be read.',
  );
  $<HTMLProgressElement>('#progress').removeAttribute('value');
  if (action === 'run') {
    clearResults();
    $('#empty').hidden = false;
    $('#empty').querySelector('p')!.textContent = 'Reading small regions…';
    renderGrid();
  }
  worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onerror = (event) => {
    if (id !== generation) return;
    stop();
    setStatus(`Worker error: ${event.message}`, true);
  };
  worker.onmessage = (event) => {
    if (event.data.id !== generation) return;
    const { type, data } = event.data;
    if (type === 'network') {
      readNetwork = data;
      renderReadingProgress();
    } else if (type === 'progress') {
      const p = data as Progress;
      setStatus(`${p.stage} · ${p.cells} objects`);
      renderReadingProgress();
    } else if (type === 'metadata') {
      displayMetadata(data.metadata, data.alignment, data.dtype, data.chunks);
      stop(false);
      setStatus('Metadata ready. Choose channels and a plane, then sample.');
    } else if (type === 'batch') {
      if (!firstBatchMs) firstBatchMs = performance.now() - runStarted;
      if (!result)
        result = {
          settings: s,
          cells: [],
          metadata: data.metadata,
          alignment: data.alignment,
          stats: { requests: 0, bytes: 0, cacheHits: 0, objects: [] },
          tiles: [],
          timings: {},
          warnings: [],
          created: new Date().toISOString(),
          model_id: 'pending',
        };
      result.cells.push(...data.cells);
      applyFilters();
    } else if (type === 'result') {
      result = data;
      result!.timings.first_batch = firstBatchMs;
      result!.timings.browser_to_result = performance.now() - runStarted;
      stop(false);
      finish(result!);
    } else if (type === 'error') {
      stop();
      clearResults();
      setStatus(String(data), true);
      $('#empty').querySelector('p')!.textContent = 'No result published.';
      $('#empty').querySelector('span:last-child')!.textContent =
        'Adjust the source or settings, then try again.';
    }
  };
  worker.postMessage({ id, action, settings: s });
}
$('#settings').onsubmit = (event) => {
  event.preventDefault();
  start('run');
};
button('inspect').onclick = () => start('inspect');
function clearResults() {
  selected = undefined;
  $<HTMLDialogElement>('#inspector').close();
  result = undefined;
  visible = [];
  dbReady = false;
  setExports(false);
  $('#metrics').hidden = true;
  $('#warnings').hidden = true;
  $('#run-details').textContent = 'No completed run.';
  $('#result-count').textContent = 'No completed run';
  renderGrid();
}
function setExports(enabled: boolean) {
  for (const id of ['raw', 'mosaic-png', 'manifest']) button(id).disabled = !enabled;
  for (const id of ['csv', 'parquet']) button(id).disabled = !enabled || !dbReady;
}
async function finish(run: RunResult) {
  displayMetadata(run.metadata, run.alignment);
  $('#metrics').hidden = false;
  $('#metrics').textContent =
    `${run.cells.length} objects · ${run.tiles.length} tiles · Z ${run.settings.z} · ${(run.stats.bytes / 1048576).toFixed(2)} MiB fetched · ${(run.timings.total / 1000).toFixed(2)} s`;
  $('#warnings').hidden = run.warnings.length === 0;
  $('#warnings').textContent = run.warnings.join(' ');
  $('#run-details').textContent = JSON.stringify(provenance(run), null, 2);
  setStatus(run.cells.length ? '' : 'No objects matched the filters.');
  applyFilters();
  setExports(true);
  try {
    const { loadCells } = await import('./database');
    await loadCells(run.cells);
    if (result !== run) return;
    dbReady = true;
    setExports(true);
  } catch (e) {
    if (result !== run) return;
    setStatus(e instanceof Error ? e.message : String(e), true);
  }
}
function applyFilters() {
  if (!result) return;
  const renderStart = performance.now();
  const area = Number(input('filter-area').value) || 0,
    mean = Number(input('filter-intensity').value) || 0;
  visible = result.cells.filter((c) => c.area >= area && (c.means[0] ?? 0) >= mean);
  const order = select('sort').value;
  if (order === 'random') visible = seededOrder(visible, result.settings.seed);
  else
    visible.sort((a, b) =>
      order === 'area-asc'
        ? a.area - b.area
        : order === 'area-desc'
          ? b.area - a.area
          : (b.means[0] ?? 0) - (a.means[0] ?? 0),
    );
  $('#result-count').textContent = `${visible.length} of ${result.cells.length} objects`;
  $('#empty').hidden = visible.length > 0;
  if (!visible.length) {
    $('#empty').querySelector('p')!.textContent = 'No objects in this view.';
    $('#empty').querySelector('span:last-child')!.textContent =
      'Adjust filters or sample another region.';
  }
  $('#mosaic-scroll').scrollTop = 0;
  renderGrid();
  result.timings.render = performance.now() - renderStart;
}
for (const id of ['sort', 'filter-area', 'filter-intensity'])
  $('#' + id).addEventListener('input', applyFilters);
for (const id of ['size', 'overlay', 'context', 'contrast', 'display-low', 'display-high'])
  $('#' + id).addEventListener('input', () => {
    renderGrid();
    if (selected) drawInspector();
  });
function colors(cell: Cell) {
  return cell.channels.map((channel) => (hiddenChannels.has(channel) ? '000000' : 'FFFFFF'));
}
function displayOptions(cell: Cell) {
  const low = Number(input('display-low').value),
    high = Number(input('display-high').value);
  return {
    context: input('context').checked,
    ...(select('contrast').value === 'fixed' && high > low
      ? { limits: cell.channels.map(() => [low, high] as [number, number]) }
      : {}),
  };
}
function renderGrid() {
  const grid = $('#mosaic'),
    scroll = $('#mosaic-scroll'),
    size = Number(input('size').value),
    step = size + 10,
    columns = Math.max(1, Math.floor((scroll.clientWidth - 16) / step)),
    rows = Math.ceil(visible.length / columns),
    first = Math.max(0, Math.floor(scroll.scrollTop / step) - 1),
    last = Math.min(rows, Math.ceil((scroll.scrollTop + scroll.clientHeight) / step) + 1);
  grid.style.height = `${rows * step}px`;
  grid.setAttribute('aria-rowcount', String(rows));
  grid.setAttribute('aria-colcount', String(columns));
  grid.replaceChildren();
  for (let row = first; row < last; row++)
    for (let col = 0; col < columns; col++) {
      const index = row * columns + col,
        cell = visible[index];
      if (!cell) break;
      const tile = document.createElement('button');
      tile.className = 'object-tile';
      tile.dataset.id = cell.cell_id;
      tile.style.cssText = `width:${size}px;height:${size}px;top:${row * step}px;left:${col * step + 8}px`;
      tile.setAttribute('role', 'gridcell');
      tile.setAttribute('aria-label', `Object ${cell.cell_id}, area ${cell.area} pixels`);
      tile.setAttribute('aria-rowindex', String(row + 1));
      tile.setAttribute('aria-colindex', String(col + 1));
      const canvas = document.createElement('canvas');
      drawCrop(
        canvas,
        cell,
        colors(cell),
        input('overlay').checked,
        size * 2,
        displayOptions(cell),
      );
      const caption = document.createElement('span');
      caption.textContent = `${cell.area} px²`;
      tile.append(canvas, caption);
      tile.onclick = () => openInspector(cell);
      tile.onkeydown = (event) => {
        const delta =
          event.key === 'ArrowRight'
            ? 1
            : event.key === 'ArrowLeft'
              ? -1
              : event.key === 'ArrowDown'
                ? columns
                : event.key === 'ArrowUp'
                  ? -columns
                  : 0;
        if (!delta) return;
        event.preventDefault();
        const next = Math.max(0, Math.min(visible.length - 1, index + delta)),
          nextRow = Math.floor(next / columns);
        scroll.scrollTop = Math.max(0, nextRow * step - step);
        renderGrid();
        grid
          .querySelector<HTMLButtonElement>(`button[data-id="${visible[next].cell_id}"]`)
          ?.focus({ preventScroll: true });
      };
      grid.append(tile);
    }
}
$('#mosaic-scroll').onscroll = () => {
  cancelAnimationFrame(gridFrame);
  gridFrame = requestAnimationFrame(renderGrid);
};
new ResizeObserver(() => renderGrid()).observe($('#mosaic-scroll'));
function openInspector(cell: Cell) {
  selected = cell;
  $('#object-title').textContent = cell.cell_id;
  const fields = $('#object-fields');
  fields.replaceChildren();
  const entries: Record<string, string> = {
    Area: `${cell.area} px²`,
    Centroid: `x ${cell.cx.toFixed(2)}, y ${cell.cy.toFixed(2)}`,
    'Physical position': `${cell.physical_x.toFixed(3)}, ${cell.physical_y.toFixed(3)}, ${cell.physical_z.toFixed(3)} ${cell.unit}`,
    'Bounding box': `${cell.x}, ${cell.y} · ${cell.width} × ${cell.height} px`,
    'Sample region': `${cell.region_x}, ${cell.region_y} · ${cell.region_width} × ${cell.region_height} px`,
    'Native crop': `${cell.crop.width} × ${cell.crop.height} px`,
    Source: cell.source,
    'Segmentation version': cell.segmentation_version,
    Plane: `level ${cell.level}, t ${cell.t}, z ${cell.z}`,
    'Instance ID': String(cell.label),
    'Reader / segmentation': `${cell.reader} / ${cell.segmentation}`,
    Model: cell.model_id,
    Seed: cell.seed,
    'Tile edge': cell.edge ? 'Yes · potentially incomplete' : 'No',
  };
  cell.means.forEach(
    (mean, i) => (entries[`Mean · channel ${cell.channels[i]}`] = mean.toFixed(3)),
  );
  for (const [name, value] of Object.entries(entries)) {
    const dt = document.createElement('dt'),
      dd = document.createElement('dd');
    dt.textContent = name;
    dd.textContent = value;
    fields.append(dt, dd);
  }
  const link = $<HTMLAnchorElement>('#source-link');
  link.href = 'https://ome.github.io/ome-ngff-validator/?source=' + encodeURIComponent(cell.source);
  drawInspector();
  $<HTMLDialogElement>('#inspector').showModal();
}
function drawInspector() {
  if (!selected || !result) return;
  drawCrop(
    $<HTMLCanvasElement>('#inspector-canvas'),
    selected,
    colors(selected),
    true,
    600,
    displayOptions(selected),
  );
  const canvas = $<HTMLCanvasElement>('#origin'),
    ctx = canvas.getContext('2d')!,
    a = result.alignment,
    w = a.shape[a.axes.indexOf('x')],
    h = a.shape[a.axes.indexOf('y')],
    scale = Math.min((canvas.width - 20) / w, (canvas.height - 20) / h);
  ctx.fillStyle = '#101b20';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#56656a';
  ctx.strokeRect(10, 10, w * scale, h * scale);
  for (const tile of result.tiles) {
    ctx.fillStyle = '#31464b';
    ctx.fillRect(10 + tile.x * scale, 10 + tile.y * scale, tile.width * scale, tile.height * scale);
  }
  ctx.strokeStyle = '#f1d987';
  ctx.lineWidth = 2;
  ctx.strokeRect(
    10 + selected.x * scale,
    10 + selected.y * scale,
    Math.max(3, selected.width * scale),
    Math.max(3, selected.height * scale),
  );
}
button('close').onclick = () => $<HTMLDialogElement>('#inspector').close();
button('share').onclick = async () => {
  try {
    const url = withView(settingsUrl(readSettings(), location.href), readView());
    history.replaceState(null, '', url);
    await navigator.clipboard.writeText(url);
    setStatus('Reproducible sampling + display link copied.');
  } catch (e) {
    setStatus(`Could not copy link: ${e instanceof Error ? e.message : e}`, true);
  }
};
async function perform(action: () => Promise<void>) {
  try {
    await action();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  }
}
for (const format of ['csv', 'parquet'] as const)
  button(format).onclick = () =>
    perform(async () => {
      const snapshot = result;
      const query = `SELECT * FROM cells WHERE cell_id IN (${visible.length ? visible.map((c) => `'${c.cell_id.replaceAll("'", "''")}'`).join(',') : "'__no_objects__'"})`;
      const { exportTable } = await import('./database');
      const bytes = await exportTable(query, format);
      if (result !== snapshot) return;
      download(bytes, `musivarium.${format}`);
    });
button('manifest').onclick = () => {
  if (result)
    download(
      new TextEncoder().encode(
        JSON.stringify(
          {
            ...provenance(result),
            view: readView(),
            visible_cell_ids: visible.map((c) => c.cell_id),
          },
          null,
          2,
        ),
      ),
      'musivarium-run.json',
      'application/json',
    );
};
button('raw').onclick = () =>
  perform(async () => {
    if (!result) return;
    const snapshot = result,
      cells = [...visible];
    button('raw').disabled = true;
    setStatus('Preparing native crop archive…');
    try {
      const bytes = await cropArchive(snapshot, cells);
      if (result !== snapshot) return;
      download(bytes, 'musivarium-crops.zip', 'application/zip');
      setStatus('Native crop archive exported with per-object metadata and original dtypes.');
    } finally {
      if (result === snapshot) button('raw').disabled = false;
    }
  });
function saveCanvas(canvas: HTMLCanvasElement, name: string): Promise<void> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(Error('PNG encoding failed'));
        return;
      }
      download(blob, name);
      resolve();
    }, 'image/png'),
  );
}
button('crop-png').onclick = () =>
  perform(async () => {
    if (selected)
      await saveCanvas(
        $<HTMLCanvasElement>('#inspector-canvas'),
        selected.cell_id + '-preview.png',
      );
  });
button('mosaic-png').onclick = () =>
  perform(async () => {
    if (!visible.length) throw Error('No visible objects to export');
    const size = 96,
      cols = Math.min(16, Math.ceil(Math.sqrt(visible.length))),
      canvas = document.createElement('canvas');
    canvas.width = cols * size;
    canvas.height = Math.ceil(visible.length / cols) * size;
    const ctx = canvas.getContext('2d')!;
    visible.forEach((cell, i) => {
      const tile = document.createElement('canvas');
      drawCrop(tile, cell, colors(cell), input('overlay').checked, size, displayOptions(cell));
      ctx.drawImage(tile, (i % cols) * size, Math.floor(i / cols) * size);
    });
    await saveCanvas(canvas, 'musivarium-mosaic-preview.png');
  });

if (initialSettingsValid) start('run');
