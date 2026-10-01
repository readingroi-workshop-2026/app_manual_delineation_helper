# Vendored: surface-annotate viewer engine

`viewer.js` and `mesh.js` are **copies** of the files of the same name in
[app_surface_annotate](https://github.com/yongninglei/app_surface_annotate),
`src/surface_annotate/static/`. They render the surfaces (linked inflated +
pial panels, lighting, opacity, mesh, picking) for this app.

Do not edit them here. Change them in surface-annotate, then copy them over:

```bash
cp ../app_surface_annotate/src/surface_annotate/static/{viewer.js,mesh.js} static/vendor/surface_annotate/
```

`tests/test_app.py::test_vendored_engine_matches_surface_annotate` fails when
the sibling checkout exists and the copies differ (it is skipped otherwise).
