// Mesh algorithms on the shared vertex graph (no three.js, no DOM) so they
// can be tested with `node --test`. Inflated and pial share vertex indices,
// so everything here is surface-agnostic except where coords are passed in.

// Compressed neighbour lists: neighbours of v are nbr[off[v] .. off[v+1]).
export function buildAdjacency(faces, n) {
  const deg = new Uint32Array(n);
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
    deg[a] += 2; deg[b] += 2; deg[c] += 2;
  }
  const off = new Uint32Array(n + 1);
  for (let v = 0; v < n; v++) off[v + 1] = off[v] + deg[v];
  const raw = new Int32Array(off[n]);
  const fill = off.slice(0, n);
  const push = (u, w) => { raw[fill[u]++] = w; };
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
    push(a, b); push(a, c); push(b, a); push(b, c); push(c, a); push(c, b);
  }
  // Every interior edge is seen from both of its faces: dedupe per vertex.
  const outOff = new Uint32Array(n + 1);
  const out = new Int32Array(raw.length);
  let k = 0;
  for (let v = 0; v < n; v++) {
    outOff[v] = k;
    const seen = new Set();
    for (let j = off[v]; j < off[v + 1]; j++) {
      const w = raw[j];
      if (!seen.has(w)) { seen.add(w); out[k++] = w; }
    }
  }
  outOff[n] = k;
  return { n, off: outOff, nbr: out.slice(0, k) };
}

function dist(coords, a, b) {
  const dx = coords[3 * a] - coords[3 * b];
  const dy = coords[3 * a + 1] - coords[3 * b + 1];
  const dz = coords[3 * a + 2] - coords[3 * b + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// Shortest edge path src -> dst (inclusive), weighted by edge length on `coords`.
// `cost` (optional, per vertex): an edge into vertex w costs length * cost[w],
// e.g. 1 inside a thresholded map and much more outside it, so the path keeps
// to the map where it can and still connects when it can't.
export function shortestPath(adj, coords, src, dst, cost = null) {
  if (src === dst) return [src];
  const d = new Float64Array(adj.n).fill(Infinity);
  const prev = new Int32Array(adj.n).fill(-1);
  const heap = new MinHeap();
  d[src] = 0;
  heap.push(0, src);
  while (heap.size) {
    const u = heap.pop();
    if (u === dst) break;
    const du = d[u];
    for (let j = adj.off[u]; j < adj.off[u + 1]; j++) {
      const w = adj.nbr[j];
      const nd = du + dist(coords, u, w) * (cost ? cost[w] : 1);
      if (nd < d[w]) { d[w] = nd; prev[w] = u; heap.push(nd, w); }
    }
  }
  if (prev[dst] < 0) return null;
  const path = [];
  for (let v = dst; v !== -1; v = prev[v]) path.push(v);
  return path.reverse();
}

// Join control points with shortest paths; closed=true adds last -> first.
// `cost`: see shortestPath.
export function tracePath(adj, coords, points, closed = false, cost = null) {
  if (points.length === 0) return [];
  const out = [points[0]];
  const hops = closed && points.length > 2 ? [...points, points[0]] : points;
  for (let i = 1; i < hops.length; i++) {
    const seg = shortestPath(adj, coords, hops[i - 1], hops[i], cost);
    if (!seg) continue;
    for (let j = 1; j < seg.length; j++) out.push(seg[j]);
  }
  return out;
}

// Label connected components of the vertices where blocked[v] == 0.
// Returns { comp: Int32Array (-1 for blocked), sizes: number[] }.
export function components(adj, blocked) {
  const comp = new Int32Array(adj.n).fill(-1);
  const sizes = [];
  const stack = [];
  for (let s = 0; s < adj.n; s++) {
    if (blocked[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    comp[s] = id;
    stack.push(s);
    while (stack.length) {
      const u = stack.pop();
      size++;
      for (let j = adj.off[u]; j < adj.off[u + 1]; j++) {
        const w = adj.nbr[j];
        if (!blocked[w] && comp[w] < 0) { comp[w] = id; stack.push(w); }
      }
    }
    sizes.push(size);
  }
  return { comp, sizes };
}

// A closed edge loop splits the mesh; the inside is everything except the
// largest remaining component (the loop itself included). `seed`, when given,
// picks the side explicitly instead.
export function fillLoop(adj, loop, seed = -1) {
  const mask = new Uint8Array(adj.n);
  for (const v of loop) mask[v] = 1;
  const { comp, sizes } = components(adj, mask);
  if (seed >= 0 && comp[seed] >= 0) {
    const keep = comp[seed];
    for (let v = 0; v < adj.n; v++) if (comp[v] === keep) mask[v] = 1;
    return mask;
  }
  let outside = -1;
  for (let i = 0; i < sizes.length; i++) if (outside < 0 || sizes[i] > sizes[outside]) outside = i;
  for (let v = 0; v < adj.n; v++) if (comp[v] >= 0 && comp[v] !== outside) mask[v] = 1;
  return mask;
}

// Fill every hole in a label: all non-label components except the largest.
export function fillHoles(adj, mask) {
  const { comp, sizes } = components(adj, mask);
  let outside = -1;
  for (let i = 0; i < sizes.length; i++) if (outside < 0 || sizes[i] > sizes[outside]) outside = i;
  const out = mask.slice();
  for (let v = 0; v < adj.n; v++) if (comp[v] >= 0 && comp[v] !== outside) out[v] = 1;
  return out;
}

// Vertices within `radius` (straight-line, on `coords`) of `center` that are
// reachable through such vertices -- so a brush on pial doesn't jump a sulcus.
export function brush(adj, coords, center, radius) {
  const hit = [center];
  const seen = new Set([center]);
  for (let i = 0; i < hit.length; i++) {
    const u = hit[i];
    for (let j = adj.off[u]; j < adj.off[u + 1]; j++) {
      const w = adj.nbr[j];
      if (!seen.has(w)) {
        seen.add(w);
        if (dist(coords, center, w) <= radius) hit.push(w);
      }
    }
  }
  return hit;
}

// Vertices whose value differs from at least one neighbour's.
export function boundary(adj, values) {
  const out = new Uint8Array(adj.n);
  for (let u = 0; u < adj.n; u++) {
    const a = values[u];
    for (let j = adj.off[u]; j < adj.off[u + 1]; j++) {
      if (values[adj.nbr[j]] !== a) { out[u] = 1; break; }
    }
  }
  return out;
}

// Inner edge of a 0/1 mask: label vertices that touch a non-label vertex.
export function maskOutline(adj, mask) {
  const out = new Uint8Array(adj.n);
  for (let u = 0; u < adj.n; u++) {
    if (!mask[u]) continue;
    for (let j = adj.off[u]; j < adj.off[u + 1]; j++) {
      if (!mask[adj.nbr[j]]) { out[u] = 1; break; }
    }
  }
  return out;
}
