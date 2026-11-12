#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.4.6", "scipy==1.17.1", "scikit-image==0.26.0", "zarr==2.18.4", "numcodecs==0.15.0", "requests==2.34.2"]
# ///
"""Independent native-pixel reference; never imports application code.

uv run scripts/validate-reference.py                       # offline verification
uv run scripts/validate-reference.py --live                # pinned native Zarr reads
uv run scripts/validate-reference.py --rebuild --qualification-cache /path/to/evidence

Rebuild needs the original qualification requests-index.json + response bodies,
or --live. Both validate every source body against its checked-in content hash.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import time

import numpy as np
import requests
import scipy
from scipy import ndimage
import skimage
from skimage.measure import regionprops
import zarr

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests/fixtures/idr0076-10501752"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def dump(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n")


def checked(data: bytes, record: dict) -> bytes:
    assert len(data) == record["bytes"], f"Byte length changed: {record.get('url', record.get('path'))}"
    assert sha(data) == record["sha256"], f"SHA-256 changed: {record.get('url', record.get('path'))}"
    return data


def source_bodies(manifest: dict, live: bool, cache: Path | None) -> dict[str, bytes]:
    records = [] if cache is None else json.loads((cache / "requests-index.json").read_text())
    bodies = {}
    for pinned in manifest["sources"]:
        url = pinned["url"]
        body: bytes | None = None
        if live:
            for attempt in range(3):
                try:
                    with requests.get(url, timeout=(10, 45), stream=True,
                                      headers={"User-Agent": "Musivarium-scientific-validation/1"}) as response:
                        response.raise_for_status()
                        chunks, received = [], 0
                        for chunk in response.iter_content(64 * 1024):
                            received += len(chunk)
                            if received > 16 * 1024 * 1024:
                                raise ValueError(f"Source exceeds 16 MiB: {url}")
                            chunks.append(chunk)
                        body = b"".join(chunks)
                    if len(body) != pinned["bytes"]:
                        raise requests.RequestException(f"Truncated/changed source body ({len(body)} vs {pinned['bytes']} bytes)")
                    break
                except (requests.RequestException, TimeoutError) as error:
                    if attempt == 2:
                        raise RuntimeError(f"Real source unavailable (no fixture fallback): {url}: {error}") from error
                    time.sleep(attempt + 1)
        else:
            assert cache is not None
            record = next((r for r in records if r["url"] == url and r["method"] == "GET" and r["status"] == 200), None)
            if record is None:
                raise ValueError(f"Missing original qualification response: {url}")
            original = Path(record["body_file"])
            body = (original if original.exists() else cache / original.name).read_bytes()
        assert body is not None
        bodies[url] = checked(body, pinned)
    return bodies


def native_roi(manifest: dict, bodies: dict[str, bytes], cache: Path | None) -> tuple[np.ndarray, np.ndarray]:
    base = manifest["image_group"]
    store = {url[len(base):]: body for url, body in bodies.items() if url.startswith(base)}
    image_array = zarr.open_array(store, path="0", mode="r")
    label_array = zarr.open_array(store, path="labels/0/0", mode="r")
    assert image_array.shape == (50, 494, 464) and image_array.dtype == np.dtype("<f8")
    assert label_array.shape == (1, 494, 464) and label_array.dtype == np.dtype("<i2")
    # Read actual, separately compressed label chunks across their y=247 seam.
    image = image_array[42, :, :]
    labels = label_array[0, :, :]
    if cache is not None:
        np.testing.assert_array_equal(image, np.load(cache / "label-source-c42.npy"))
        np.testing.assert_array_equal(labels, np.load(cache / "instance-label-plane.npy"))
    roi = manifest["region"]
    selection = (slice(roi["y"], roi["y"] + roi["height"]), slice(roi["x"], roi["x"] + roi["width"]))
    return np.ascontiguousarray(image[selection], dtype="<f8"), np.ascontiguousarray(labels[selection], dtype="<i2")


def reference(image: np.ndarray, labels: np.ndarray, manifest: dict) -> dict:
    roi = manifest["region"]
    x, y = roi["x"], roi["y"]
    height, width = labels.shape
    assert image.shape == labels.shape == (roi["height"], roi["width"])
    ids = np.unique(labels[labels != 0])
    # regionprops handles label identity, even for disconnected equal-ID pieces.
    # scipy independently verifies count, mean and geometric centroid.
    areas = ndimage.sum_labels(np.ones(labels.shape, dtype=np.uint8), labels, ids)
    means = ndimage.mean(image, labels, ids)
    centers = ndimage.center_of_mass(np.ones(labels.shape), labels, ids)
    objects, crops = [], []
    for index, obj in enumerate(regionprops(labels, intensity_image=image)):
        y0, x0, y1, x1 = obj.bbox  # skimage is row,col; max coordinates exclusive.
        assert obj.label == int(ids[index])
        assert obj.area == areas[index]
        np.testing.assert_allclose(obj.centroid, centers[index], rtol=0, atol=1e-12)
        np.testing.assert_allclose(obj.intensity_mean, means[index], rtol=0, atol=1e-12)
        edge = y0 == 0 or x0 == 0 or y1 == height or x1 == width
        objects.append({"label": int(obj.label), "area": int(obj.area),
                        "cx": x + float(obj.centroid[1]), "cy": y + float(obj.centroid[0]),
                        "x": x + x0, "y": y + y0, "width": x1-x0, "height": y1-y0,
                        "edge": edge, "means": [float(obj.intensity_mean)]})
        # Square, bbox-centered native crops: symmetric minimum padding,
        # optional 32-pixel minimum, round top/left down, then clip to ROI.
        # Bounds come from skimage, not application measurements.
        for padding, minimum_size in [(0, 0), (8, 0), (0, 32), (8, 32)]:
            side = max(x1-x0 + 2*padding, y1-y0 + 2*padding, minimum_size)
            requested_left = math.floor((x0+x1-side)/2)
            requested_top = math.floor((y0+y1-side)/2)
            left, top = max(0, requested_left), max(0, requested_top)
            right, bottom = min(width, requested_left+side), min(height, requested_top+side)
            crop = np.ascontiguousarray(image[top:bottom, left:right], dtype="<f8")
            mask = np.ascontiguousarray(labels[top:bottom, left:right] == obj.label, dtype=np.uint8)
            isolated = np.ascontiguousarray(np.where(mask, crop, 0), dtype="<f8")
            assert int(mask.sum()) == int(obj.area)
            crops.append({"label": int(obj.label), "padding": padding, "minimum_size": minimum_size,
                          "clipped": left != requested_left or top != requested_top or right != requested_left+side or bottom != requested_top+side,
                          "region": {"x": x+left, "y": y+top, "width": right-left, "height": bottom-top},
                          "image_sha256": sha(crop.tobytes()), "mask_sha256": sha(mask.tobytes()),
                          "masked_image_sha256": sha(isolated.tobytes())})
    return {"schema_version": 1, "reference": {"numpy": np.__version__, "scipy": scipy.__version__,
            "scikit_image": skimage.__version__, "zarr": zarr.__version__,
            "algorithm": "skimage.measure.regionprops; scipy.ndimage independent cross-checks",
            "coordinate_convention": "global x,y pixel indices; exclusive bbox right/bottom; no half-pixel offset",
            "mean_tolerance_absolute": 1e-11},
            "image_sha256": sha(image.astype("<f8").tobytes()),
            "labels_sha256": sha(labels.astype("<i2").tobytes()),
            "object_count": len(objects), "foreground_pixels": int(np.count_nonzero(labels)),
            "edge_labels": [o["label"] for o in objects if o["edge"]],
            "interior_labels": [o["label"] for o in objects if not o["edge"]],
            "objects": objects, "crops": crops}


def compare(actual: dict, expected: dict) -> None:
    for key in ["schema_version", "image_sha256", "labels_sha256", "object_count", "foreground_pixels", "edge_labels", "interior_labels", "crops"]:
        assert actual[key] == expected[key], f"Reference mismatch: {key}"
    assert len(actual["objects"]) == len(expected["objects"])
    for obj, pinned in zip(actual["objects"], expected["objects"], strict=True):
        for key in ["label", "area", "x", "y", "width", "height", "edge"]:
            assert obj[key] == pinned[key], f"Object {pinned['label']}: {key}"
        for key in ["cx", "cy", "means"]:
            np.testing.assert_allclose(obj[key], pinned[key], rtol=0, atol=1e-11, err_msg=f"Object {pinned['label']}: {key}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Fetch hash-pinned real HTTP sources; no cache fallback")
    parser.add_argument("--qualification-cache", type=Path, help="Original qualified response index, bodies and .npy arrays")
    parser.add_argument("--rebuild", action="store_true", help="Explicitly regenerate checked-in ROI bytes and expected.json")
    parser.add_argument("--report", type=Path, help="Optional machine-readable verification report")
    args = parser.parse_args()
    if args.rebuild and not (args.live or args.qualification_cache):
        parser.error("--rebuild requires --live or --qualification-cache")
    manifest = json.loads((FIXTURE / "manifest.json").read_text())
    if args.live or args.qualification_cache:
        bodies = source_bodies(manifest, args.live, args.qualification_cache)
        image, labels = native_roi(manifest, bodies, args.qualification_cache)
    else:
        image_record, label_record = manifest["files"]["image"], manifest["files"]["labels"]
        image = np.frombuffer(checked((FIXTURE / image_record["path"]).read_bytes(), image_record), dtype="<f8").reshape(64, 64)
        labels = np.frombuffer(checked((FIXTURE / label_record["path"]).read_bytes(), label_record), dtype="<i2").reshape(64, 64)
    actual = reference(image, labels, manifest)
    if args.rebuild:
        for kind, array in [("image", image), ("labels", labels)]:
            record = manifest["files"][kind]
            data = checked(array.tobytes(), record)
            (FIXTURE / record["path"]).write_bytes(data)
        dump(FIXTURE / "expected.json", actual)
    expected = json.loads((FIXTURE / "expected.json").read_text())
    compare(actual, expected)
    report = {"status": "pass", "mode": "native-live" if args.live else "qualification-rebuild" if args.qualification_cache else "offline",
              "source": manifest["image_group"], "region": manifest["region"],
              "image_sha256": actual["image_sha256"], "labels_sha256": actual["labels_sha256"],
              "objects_compared": actual["object_count"], "crops_compared": len(actual["crops"]),
              "foreground_pixels": actual["foreground_pixels"], "reference": actual["reference"]}
    if args.report:
        dump(args.report, report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Scientific validation failed: {error}", file=sys.stderr)
        sys.exit(1)
