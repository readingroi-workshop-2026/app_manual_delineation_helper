// node --test tests/  — the drawing algorithms, on a small grid mesh.
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../static/engine/mesh.js";

// W x H grid of unit squares, each split into two triangles.
function grid(W, H) {
  const coords = new Float32Array(W * H * 3);
  const faces = [];
  const id = (x, y) => y * W + x;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) coords.set([x, y, 0], 3 * id(x, y));
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      faces.push(id(x, y), id(x + 1, y), id(x + 1, y + 1));
      faces.push(id(x, y), id(x + 1, y + 1), id(x, y + 1));
    }
  }
  return { coords, faces: Int32Array.from(faces), id, n: W * H };
}

test("adjacency is symmetric and deduplicated", () => {
  const g = grid(4, 4);
  const adj = M.buildAdjacency(g.faces, g.n);
  const nb = (v) => [...adj.nbr.slice(adj.off[v], adj.off[v + 1])].sort((a, b) => a - b);
  assert.deepEqual(nb(g.id(1, 1)), [g.id(0, 0), g.id(1, 0), g.id(0, 1), g.id(2, 1), g.id(1, 2), g.id(2, 2)].sort((a, b) => a - b));
  for (let v = 0; v < g.n; v++) for (const w of nb(v)) assert.ok(nb(w).includes(v));
});

test("shortest path follows the diagonal edges", () => {
  const g = grid(6, 6);
  const adj = M.buildAdjacency(g.faces, g.n);
  const p = M.shortestPath(adj, g.coords, g.id(0, 0), g.id(4, 4));
  assert.deepEqual(p, [0, 1, 2, 3, 4].map((i) => g.id(i, i)));
});

test("closed contour fills the inside, not the larger outside", () => {
  const g = grid(12, 12);
  const adj = M.buildAdjacency(g.faces, g.n);
  const pts = [g.id(3, 3), g.id(7, 3), g.id(7, 7), g.id(3, 7)];
  const loop = M.tracePath(adj, g.coords, pts, true);
  assert.equal(loop[0], loop[loop.length - 1]);
  const mask = M.fillLoop(adj, loop);
  let n = 0;
  for (const v of mask) n += v;
  assert.equal(n, 25); // 5 x 5 box, boundary included
  assert.equal(mask[g.id(5, 5)], 1);
  assert.equal(mask[g.id(0, 0)], 0);
  // A seed outside picks the other side.
  const out = M.fillLoop(adj, loop, g.id(0, 0));
  assert.equal(out[g.id(5, 5)], 0);
  assert.equal(out[g.id(11, 11)], 1);
});

test("fillHoles closes an interior gap", () => {
  const g = grid(9, 9);
  const adj = M.buildAdjacency(g.faces, g.n);
  const mask = new Uint8Array(g.n);
  for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) mask[g.id(x, y)] = 1;
  mask[g.id(4, 4)] = 0;
  const filled = M.fillHoles(adj, mask);
  assert.equal(filled[g.id(4, 4)], 1);
  assert.equal(filled[g.id(0, 0)], 0);
});

test("brush stays within radius and connected", () => {
  const g = grid(10, 10);
  const adj = M.buildAdjacency(g.faces, g.n);
  const hit = M.brush(adj, g.coords, g.id(5, 5), 1.0);
  assert.deepEqual(hit.sort((a, b) => a - b),
    [g.id(5, 4), g.id(4, 5), g.id(5, 5), g.id(6, 5), g.id(5, 6)].sort((a, b) => a - b));
});

test("boundary and outline", () => {
  const g = grid(5, 1 + 4);
  const adj = M.buildAdjacency(g.faces, g.n);
  const vals = new Int32Array(g.n);
  for (let v = 0; v < g.n; v++) vals[v] = g.coords[3 * v] < 2 ? 0 : 1;
  const b = M.boundary(adj, vals);
  assert.equal(b[g.id(1, 2)], 1);
  assert.equal(b[g.id(2, 2)], 1);
  assert.equal(b[g.id(4, 2)], 0);
  const o = M.maskOutline(adj, Uint8Array.from(vals));
  assert.equal(o[g.id(1, 2)], 0);
  assert.equal(o[g.id(2, 2)], 1);
});
