// Label-editing algorithms on the vertex graph, FreeView style (no three.js,
// no DOM, so `node --test tests/draw.test.mjs` can run them). They build on
// the adjacency of the vendored mesh.js and live here, not there, because the
// engine files are shared with app_surface_t1w_labeling (see static/engine/README.md).

// FreeView's "custom fill": every vertex reachable from `seed` through
// vertices where allowed[v] is 1, never stepping onto a barrier vertex (the
// drawn path). Barrier vertices next to the filled region are then added too
// ("up to and including the path"). Returns a 0/1 mask; empty when the seed
// itself is not allowed or is on the barrier.
export function floodFill(adj, seed, allowed, barrier = null) {
  const out = new Uint8Array(adj.n);
  if (!allowed[seed] || (barrier && barrier[seed])) return out;
  out[seed] = 1;
  const stack = [seed];
  while (stack.length) {
    const u = stack.pop();
    for (let j = adj.off[u]; j < adj.off[u + 1]; j++) {
      const w = adj.nbr[j];
      if (!out[w] && allowed[w] && !(barrier && barrier[w])) { out[w] = 1; stack.push(w); }
    }
  }
  if (barrier) {
    const edge = [];
    for (let v = 0; v < adj.n; v++) {
      if (!barrier[v] || !allowed[v]) continue;
      for (let j = adj.off[v]; j < adj.off[v + 1]; j++) {
        if (out[adj.nbr[j]]) { edge.push(v); break; }
      }
    }
    for (const v of edge) out[v] = 1;
  }
  return out;
}

// Grow a label by one ring of neighbours (only into allowed vertices, if given).
export function dilate(adj, mask, allowed = null) {
  const out = mask.slice();
  for (let u = 0; u < adj.n; u++) {
    if (!mask[u]) continue;
    for (let j = adj.off[u]; j < adj.off[u + 1]; j++) {
      const w = adj.nbr[j];
      if (!allowed || allowed[w]) out[w] = 1;
    }
  }
  return out;
}

// Shrink a label by its outer ring: drop every vertex that touches a non-label one.
export function erode(adj, mask) {
  const out = mask.slice();
  for (let u = 0; u < adj.n; u++) {
    if (!mask[u]) continue;
    for (let j = adj.off[u]; j < adj.off[u + 1]; j++) {
      if (!mask[adj.nbr[j]]) { out[u] = 0; break; }
    }
  }
  return out;
}
