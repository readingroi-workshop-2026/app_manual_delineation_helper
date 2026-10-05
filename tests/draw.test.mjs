// node --test tests/draw.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdjacency } from "../static/engine/mesh.js";
import { floodFill, dilate, erode } from "../static/draw.js";

// A 1 x 6 strip of triangles: vertices 0-5 on top, 6-11 below.
const faces = [];
for (let i = 0; i < 5; i++) faces.push(i, i + 1, i + 6, i + 1, i + 7, i + 6);
const adj = buildAdjacency(Int32Array.from(faces), 12);
const ones = new Uint8Array(12).fill(1);
const set = (m) => [...m.keys()].filter((i) => m[i]);

test("fill stops at the barrier and includes it", () => {
  const barrier = new Uint8Array(12);
  barrier[3] = barrier[9] = 1; // a cut across the strip
  assert.deepEqual(set(floodFill(adj, 0, ones, barrier)), [0, 1, 2, 3, 6, 7, 8, 9]);
  assert.deepEqual(set(floodFill(adj, 3, ones, barrier)), []); // seed on the path
});

test("fill honours the allowed mask", () => {
  const allowed = ones.slice();
  allowed[2] = allowed[8] = 0;
  assert.deepEqual(set(floodFill(adj, 0, allowed)), [0, 1, 6, 7]);
});

test("dilate and erode", () => {
  const m = new Uint8Array(12);
  m[2] = 1;
  const d = dilate(adj, m);
  assert.deepEqual(set(d), [1, 2, 3, 7, 8]);
  assert.deepEqual(set(erode(adj, d)), [2]); // 2 is interior after dilation
});
