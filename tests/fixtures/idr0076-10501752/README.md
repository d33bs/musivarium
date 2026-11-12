# Real IDR0076 / image 10501752 fixture

**Data: CC BY 4.0, copyright Ali et al.**

Attribution: Ali et al., _Imaging mass cytometry and multiplatform genomics define
the phenogenomic landscape of breast cancer_ (2020). Publication DOI:
`10.1038/s43018-020-0026-6`; data DOI: `10.17867/10000146`. Distributed by the
Image Data Resource (IDR). License URL:
`https://creativecommons.org/licenses/by/4.0/`.

These native pixels/labels are an unaltered crop of IDR0076 image 10501752:
`image[42,224:288,160:224]` and `labels[0,224:288,160:224]`, level zero.
There is no projection: source axes are `c,y,x`, with no Z/T axis. The only data
change is spatial cropping; binary packaging and reference measurements were
added. Labels are image-local cell-instance IDs, with background zero. Preserve
this attribution and license notice on redistribution.

`image-c42.f64le`: 64 × 64 little-endian Float64, C order.
`labels.i16le`: 64 × 64 little-endian signed Int16, same pixel coordinates.
Neither binary has a header. For example:

```python
image = np.fromfile('image-c42.f64le', dtype='<f8').reshape(64, 64)
labels = np.fromfile('labels.i16le', dtype='<i2').reshape(64, 64)
```

Exact original URLs, content hashes and commit-pinned license evidence are in
`manifest.json`; independent SciPy/scikit-image values for every object and
crop checksums are in `expected.json`. Rebuild/verify instructions and scientific
scope are in `docs/scientific-validation.md` at the repository root.
