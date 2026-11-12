# Reading progress and concurrency

The former progress bar counted completed regions. With a single default region it stayed at zero until both metadata and pixel reads were complete. The image/label metadata and channel reads also had sequential dependencies that were not necessary for data correctness.

## Changes

- Stream response-body byte updates from the transport through the shared reader session and processing worker to the visible reading panel.
- Show received response bytes, discovered total sizes (when exposed and meaningful), completed requests, active/queued requests, retries, and a continuously updated elapsed time. This is not a guessed overall-job percentage. Missing length or HTTP content decoding yields an indeterminate bar with real byte counts.
- Prepare image and label metadata concurrently. Let the currently needed image region download while label metadata is being parsed/validated; require matching image/label alignment before reading and accepting mask data.
- Read selected image channels and the aligned label plane concurrently. Preserve channel/result order with Promise.all and leave object selection/segmentation in deterministic region order.
- Share a maximum of four in-flight image/label HTTP requests across every source/channel, rather than allowing four separately in each reader. Reserve at most 64 MiB of logical decoded chunks across simultaneous reads.
- Keep the existing 16 MiB per-response, 96 MiB combined response-body, recent compressed-cache and retained-crop guards. Failed reads abort remaining work; cancellation removes queued permits. Model/SQL software assets are separate from image/label byte accounting.
- Do not prefetch future regions or load additional channels, time indices, Z planes or projections. A storage chunk may be larger than the requested XY region, as before.

Each current region may speculatively receive image bytes while matching label metadata is still pending; incompatible metadata aborts the run without publishing those objects. This is a bounded overlap of already-selected work, not full-volume prefetching.

## Controlled before/after measurement

An immutable scratch baseline was checked against the pre-change pipeline, reader and transport file hashes. The test alternated baseline/candidate order over three runs of each, using the exact original, hash-pinned IDR0076 HTTP response bodies and an 80 ms per-response artificial latency. It executed the actual browser reader, codecs, sampler, measurement and crop pipeline. It did not invent microscopy, substitute SQL responses or change source metadata.

| Result                                 |    Before |     After |
| -------------------------------------- | --------: | --------: |
| Median pipeline wall time              |  883.4 ms |  466.5 ms |
| Maximum simultaneously served requests |         2 |         3 |
| Objects retained                       |       100 |       100 |
| Source requests                        |        11 |        11 |
| Response-body bytes                    | 1,674,611 | 1,674,611 |

The native crop, neighboring-mask and object-measurement digest was identical in every run:

`e2f0cd2d78f548385424b2209352f8c224a1a858f6bdb53cd5be01bd05ad7b7c`

This demonstrates less serialized waiting under controlled latency, not an end-to-end WAN speed guarantee. Real IDR latency, bandwidth, retries and browser connection limits still matter. Application model/SQL startup and UI rendering are not included in this pipeline-only comparison.

Reproduce with separate Vite servers serving a saved baseline and candidate:

```sh
node scripts/benchmark-reading.mjs \
  --baseline http://127.0.0.1:5187 \
  --candidate http://127.0.0.1:5184 \
  --latency 80 --repeats 3 \
  --report /path/to/benchmark.json
```

The runner verifies every original fixture hash, identical requested object sets/bytes, native output digests and the single-plane scope. Raw local evidence is in `musivarium-parallel-reading/benchmark.json` under scratch; scratch availability is not a durable guarantee.

## Live preview evidence

A fresh non-intercepted production-preview run completed 100 IDR objects with 135 observed progress updates, known partial-download progress, three concurrent image/label requests, 2,292,160 bytes of peak reserved decoded chunks, and focus outlines enabled. It received 1,674,611 response-body bytes without JavaScript errors. The machine-readable trace is in local scratch as `musivarium-validation/reading-preview.json`.

An earlier bounded live probe did not reach completion within its wait limit; the fresh repeat passed. This variability is why the replay result is not a WAN speed guarantee.

## Regression coverage

- A real HTTP server streams an original compressed image in two parts and holds the remainder. Chromium/Firefox verify that the visible bar and elapsed time advance before a region finishes, then disappear on completion.
- Transport tests cover known/unknown/HTTP-decoded sizes, partial-body updates and retries.
- Session tests exercise four active plus queued requests, aggregate decoded reservations, and cancellation of active/queued work.
- An independent real-pixel ROI test gates label metadata and verifies image reads have already begun, followed by simultaneous aligned mask reading.
- Original-byte scientific and native-export tests still verify exact areas, centroids, native means, crops and label masks.
- Focus-outline tests inspect actual rendered pixels, verify the toggle, and exclude neighboring labels from the selected boundary.
