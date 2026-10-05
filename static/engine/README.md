# Surface engine (master copy)

`viewer.js` (the three.js renderer: linked inflated / pial panels, lighting,
opacity, x-ray of buried labels, mesh overlay, picking, cursor marker,
curvature shading) and `mesh.js` (DOM-free mesh algorithms: adjacency,
shortest paths, loop fill, brush) are **owned here**. They came from
app_surface_annotate, which was retired on 2026-10-05.

`app_surface_t1w_labeling` keeps a copy under
`src/surface_t1w_labeling/static/vendor/engine/`. After changing either file
here, copy them there:

```bash
cp static/engine/{viewer.js,mesh.js} ../app_surface_t1w_labeling/src/surface_t1w_labeling/static/vendor/engine/
```

`tests/test_app.py::test_engine_copy_matches_t1w_labeling` fails when that
sibling checkout exists and its copy differs (it is skipped otherwise).
`node --test tests/mesh.test.mjs` tests `mesh.js`.
