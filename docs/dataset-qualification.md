# Dataset qualification

Qualified **2026-11-12 UTC** (2026-11-11 US Mountain). Scope: metadata, bounded real chunk reads, instance semantics, single-plane/object crops, CORS, and independent decoding—not application implementation.

## Decision

- **Requested image: browser-readable, but not an existing-label demo.** It is a five-channel **2D** Cell Painting image, not a z-stack. Its metadata advertises no labels; its conventional `labels/zarr.json` returns 404. Keep it available for image reading, but do not claim single-cell extraction until a separate segmentation method exists.[4][17]
- **Existing-label default: IDR0076 / image 10501752.** This catalog-listed NGFF 0.4 sample contains actual **cell instance masks**, not nucleus-only or whole-organism masks. The study describes breast tumour tissue cell masks; its pinned importer reads `cellmask` files and converts each instance into an OMERO ROI.[1][59][60]
- Both exact `livingobjects.ebi.ac.uk` sources passed genuine cross-origin browser fetches. **Zarrita 0.7.5 actually decoded both sources in Chromium**, and browser/Node/native Python checksums agree. One initial requested-image fetch failed transiently; one retry succeeded. No proxy, repacking, projection, or application backend was needed for these tests. Evidence: `browser-local-origin.json`, `browser-zarrita.json`, `browser-zarrita-retry.json`, `zarrita-verification.json`, `native-zarr-verification.json` in the scratch directory below.

## Exact source URLs

```text
Requested image group:
https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/
Requested finest array:
https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/0/
Requested actual finest chunk (channel 0):
https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/0/c/0/0/0

Existing-label image group:
https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/
Existing-label finest image array:
https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/0/
Label group (relative path labels/0):
https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/labels/0/
Label finest array (relative path labels/0/0):
https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/labels/0/0/
Actual label chunks:
https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/labels/0/0/0/0/0
https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/labels/0/0/0/1/0
```

The final `/0/` in the requested URL is the **image group**; another `/0/` selects its finest array. NGFF 0.5 metadata is in `zarr.json` under `attributes.ome`; NGFF 0.4 group metadata is `.zgroup` + `.zattrs`, with `.zarray` at each array path.[4][8][13]

## Requested image: concrete reader contract

Axes **`c,y,x`**, shape **`[5,1552,2080]`**, uint16, little-endian bytes, regular chunks, fill 0; Zarr **3**, NGFF **0.5**. Codec pipeline **`bytes(endian=little)` → `zstd(level=0,checksum=false)`**; default chunk-key encoding with `/` separator, e.g. `c/0/0/0`. No sharding, filters, transpose, or extra storage transformers declared.[4][8]

| Level path | Shape `c,y,x` | Chunk shape | Scale `c,y,x` | Chunk count |
| ---------- | ------------- | ----------- | ------------- | ----------- |
| `0`        | 5,1552,2080   | 1,1024,1024 | 1,0.3,0.3     | 30 [8]      |
| `1`        | 5,776,1040    | 1,776,1024  | 1,0.6,0.6     | 10 [6]      |
| `2`        | 5,388,520     | 1,388,520   | 1,1.2,1.2     | 5 [7]       |
| `3`        | 5,194,260     | 1,194,260   | 1,2.4,2.4     | 5 [5]       |
| `4`        | 5,97,130      | 1,97,130    | 1,4.8,4.8     | 5 [14]      |
| `5`        | 5,48,65       | 1,48,65     | 1,9.6,9.6     | 5 [9]       |

Spatial units are **µm**, no translations; scales above come from group metadata, and chunk counts are ceiling-grid calculations. Respect actual odd-sized pyramid shapes, not `fullSize / scale` assumptions.[4]

Metadata display defaults, zero-based channels:[4]

| c   | Label                    | Color  | Window start–end | Active |
| --- | ------------------------ | ------ | ---------------- | ------ |
| 0   | Nuclei                   | 0000FF | 457–25000        | yes    |
| 1   | ER                       | 00FF00 | 1306–30000       | yes    |
| 2   | Nucleoli/Cytoplasmic RNA | FF0000 | 889–30000        | yes    |
| 3   | Actin/Golgi/Membrane     | FFA500 | 979–65535        | no     |
| 4   | Mitochondria             | 00FFFF | 1804–65535       | no     |

**Plane default:** no real z or t axis; UI may display the single plane as `z=0,t=0`, but reader selection is `[channel,ySlice,xSlice]`. Metadata `defaultZ=defaultT=0` does not create extra array dimensions. No maximum-intensity projection. Actual cell sizes are **unmeasured here**, because this image supplies no verified cell instance mask.[4]

All five coarsest chunks were downloaded and decoded: **28,048 compressed bytes → 31,200 uint16 bytes** (62,400 bytes if converted to float32). Finest test ROI `c=0,y=256:768,x=256:768` is 512×512; it required one **1,489,590-byte** chunk, decoded to **2,097,152 bytes**, then cropped to 524,288 bytes. Measurements are in `measurements.json`; boundary chunk trimming beyond this ROI was not tested.

## Existing cell labels: concrete reader contract

Image: **Zarr 2 / NGFF 0.4**, axes **`c,y,x`**, finest shape **`[50,494,464]`**, **`<f8` / Float64Array**, C order. Label axes are also `c,y,x` but label channel length is **1**, not 50; finest shape **`[1,494,464]`**, **`<i2` / Int16Array**, background 0. Both use fill 0, `/` chunk separation, no filters, **Blosc `cname=lz4,clevel=5,shuffle=1,blocksize=0`**.[13][15][28]

| Level | Image shape / chunk shape | Label shape / chunk shape | Spatial scale |
| ----- | ------------------------- | ------------------------- | ------------- |
| 0     | 50,494,464 / 1,494,464    | 1,494,464 / 1,247,464     | 1,1           |
| 1     | 50,247,232 / 1,247,232    | 1,247,232 / 1,247,232     | 2,2           |
| 2     | 50,123,116 / 1,123,116    | 1,123,116 / 1,123,116     | 4,4           |
| 3     | 50,61,58 / 1,61,58        | 1,61,58 / 1,61,58         | 8,8           |
| 4     | not advertised            | 1,30,29 / 1,30,29         | 16,16         |

All nine advertised array metadata files were fetched; exact bodies and URLs are in `metadata-summary.json` and `requests-index.json`. Scales are `[1,s,s]`, **no translations**; spatial units are **not declared**, so do not invent µm calibration. `image-label.source.image` is `../..`, resolving to the image group. Use **level 0 for instance measurements/crops**, with direct pixel-aligned image and label coordinates; never pair label level 4 with a nonexistent image level 4.[11][15]

**Semantics:** whole-cell segmentation regions in a 2D tissue section, not complete 3D cells. Study `ObjectNumber` is an image-local numeric cell identifier corresponding to cell mask integers. This does not establish phenotype/class membership for individual label IDs; NGFF properties here contain OMERO ROI/shape IDs, not those phenotypes. Study license: **CC BY 4.0**, attribution **Ali et al.**[15][60]

**Useful plane/defaults:** the sole 2D plane (`z=0,t=0` as UI convention), image level 0, label channel 0. Metadata-active image channels are `0,7,12,14,25,29,33,40`. A deliberately simplified demo display can use **42 = DNA1-191Ir** (window 0–223.0959930419922) and optionally **40 = panCK-175Lu** (window 0–10); channel 42 is metadata-inactive, so label this as an application override rather than the source default.[11]

**Measured instances:** decoding both finest label chunks yielded **1,713 nonzero IDs (1–1713)**, no negative values, 105,060 foreground pixels, 124,156 background pixels. **1,655** objects do not touch the image border; **58** do. Interior-object 10th/50th/90th percentiles: area **22/56/104 px²**, bounding-box width **6/9/14 px**, height **6/9/13 px**. Label transport **147,331 bytes**, decoded **458,432 bytes**. These are measured masks, not predicted biological cell diameters; evidence: `objects.json`, `measurements.json`.

**Recommended crop/sampling defaults:** native **32×32** crops, eight-pixel minimum padding around typical bounding boxes, **256×256 sampling regions** (512 does not fit this 494×464 image), count 100, deterministic seed, reject objects touching the sampled-region boundary and deduplicate by image + label ID. Enlarge the crop for larger objects rather than truncate them. Apply `labels === targetId` when isolating an object; rectangular crops alone can contain neighboring cells. Recommendations, not metadata defaults.

An actual single-object fixture uses **ID 1122**, area **56 px²**, bounding box `[180,304,189,313)` in `(x0,y0,x1,y1)` notation. Crop `[168,292,200,324)` is 32×32 and retains exactly those 56 target pixels while zeroing everything else. Files: `single-object-dna1-32.npy`, `single-object-mask-32.npy`, `native-zarr-verification.json`.

## Reproducible decoder acceptance checks

Checksums below are SHA-256 of **decoded, little-endian, C-order pixel bytes**, not `.npy` files or compressed transport. All three matched between native Python and Zarrita in **Node and a real Chromium cross-origin session** (`http://127.0.0.1:8876`). Python Zarr 2.18.4 checked the v2 arrays; Numcodecs 0.15.0 independently decoded the v3 Zstd chunk.

| Selection                                  | Type / extrema / sum                            | Pixel SHA-256                                                      |
| ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------ |
| Requested c0, y256:768, x256:768, 512²     | uint16; 741–30200; 759749615                    | `2eeaa97c1a4160da6301c6d6fd406c3f70b932663089e8f4763b99b20115a4cb` |
| Complete finest label plane, 494×464       | int16; 0–1713; 91875842                         | `599ad6afb8989b28996aa96251514577120c54b04aa5279fb704f7cee701e87d` |
| Label-source c42, y119:375, x104:360, 256² | float64; 0–201.5330047607422; 840166.0412236005 | `6938e739bb1f7fa5e68353e4068c74ac486d68485a7fe629166fb6a3c821161c` |

## CORS, bounds, evidence, remaining limits

- With `Origin: http://localhost:5173`, exact-host **GET group metadata, array metadata, and real chunks** returned 200 and reflected `Access-Control-Allow-Origin: http://localhost:5173`, plus allow-credentials true. `OPTIONS` requesting GET + `Range` returned 200 with allowed origin, method GET, header Range. Header names are case-insensitive: this server emits lowercase headers. The early probe's case-sensitive display was corrected; do not mistake that display bug for missing CORS. Evidence: `cors.json`, original per-request records.
- Genuine browser requests from `https://idr.github.io` and `http://127.0.0.1:8876` succeeded; the latter exercised group metadata, array metadata, and chunks for both sources. Use `credentials: omit`; no credential requirement was demonstrated. A transient first requested ROI failure is retained alongside the successful retry, so resilient UI timeout/retry reporting remains necessary.
- Alternate host **`https://uk1s3.embassy.ebi.ac.uk`**, preserving the entire `/idr/...` path, returned identical bytes for six tested metadata/chunk objects and `Access-Control-Allow-Origin: *`; however its forced GET+Range preflights returned **403**. Prefer the requested host; do not assume every header/range combination works on the alternate.
- Requested v3 group has `consolidated_metadata: null`; `.zmetadata` also returned 404. Selected v2 `.zmetadata` returned 404. V2 array `.zattrs` files returned 404; required axes/transforms are on the groups. The client must tolerate absent optional metadata, not mark these valid arrays unreadable.
- Scratch evidence: **`/Users/buntend/.hermes/cache/scratch/musivarium-qualification/`**. `requests-index.json` indexes **73 bounded Python HTTP requests / 5,900,983 response-body bytes**, including negative lookups, source retrieval, origin variants, and alternate-host comparisons; these totals exclude separate browser/package traffic. Every recorded response has URL, method, timestamp, full returned headers, raw body file, length, and SHA-256. Requests use 15s connect/60s read timeouts, max concurrency 4, and a 16 MiB per-response guard. Some exploratory GitHub lookups returned 404; the final pinned provenance sources succeeded.
- Probe/fixture scripts, `.npy` arrays, original compressed chunks, npm lockfile, and browser bundle remain **only in scratch**, which may be automatically pruned. No full-resolution 50-channel scan, application renderer, mosaic UX, model inference, arbitrary dataset support, or deployment was tested. The requested image's segmentation remains the only dataset-level gap for existing-label single-cell mode.

## Sources

[1] [https://idr.github.io/ome-ngff-samples](https://idr.github.io/ome-ngff-samples)

[4] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/zarr.json](https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/zarr.json)

[5] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/3/zarr.json](https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/3/zarr.json)

[6] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/1/zarr.json](https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/1/zarr.json)

[7] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/2/zarr.json](https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/2/zarr.json)

[8] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/0/zarr.json](https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/0/zarr.json)

[9] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/5/zarr.json](https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/5/zarr.json)

[11] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/.zattrs](https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/.zattrs)

[13] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/0/.zarray](https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/0/.zarray)

[14] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/4/zarr.json](https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/4/zarr.json)

[15] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/labels/0/.zattrs](https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/labels/0/.zattrs)

[17] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/labels/zarr.json](https://livingobjects.ebi.ac.uk/idr/zarr/v0.5/idr0033A/BR00109990_C2.zarr/0/labels/zarr.json)

[28] [https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/labels/0/0/.zarray](https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr/labels/0/0/.zarray)

[59] [https://raw.githubusercontent.com/IDR/idr0076-ali-metabric/276992b791d35ab4cdafe0f75190f328d4aed4fc/experimentA/rois.py](https://raw.githubusercontent.com/IDR/idr0076-ali-metabric/276992b791d35ab4cdafe0f75190f328d4aed4fc/experimentA/rois.py)

[60] [https://raw.githubusercontent.com/IDR/idr0076-ali-metabric/276992b791d35ab4cdafe0f75190f328d4aed4fc/idr0076-study.txt](https://raw.githubusercontent.com/IDR/idr0076-ali-metabric/276992b791d35ab4cdafe0f75190f328d4aed4fc/idr0076-study.txt)
