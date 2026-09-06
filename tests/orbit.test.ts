import test from "node:test";
import assert from "node:assert/strict";
import { orbitLayout } from "../web/orbit-layout.js";
import { demoRepository } from "../src/demo.js";
import type { MapData } from "../web/Galaxy.js";
const demo = demoRepository();
const data = {
  ...demo,
  nodes: demo.graph.nodes,
  edges: demo.graph.edges,
  files: demo.graph.files.length,
} as unknown as MapData;
test("orbital map counts real components, has stable layout, and expands counted regions", () => {
  const a = orbitLayout(data);
  assert.equal(a.bodies.length, data.files);
  assert(!a.aggregated);
  assert.deepEqual(a, orbitLayout(data));
  assert.equal(new Set(a.bodies.map((b) => b.id)).size, data.files);
  const big = {
    ...data,
    files: 2000,
    nodes: Array.from({ length: 2000 }, (_, i) => ({
      ...data.nodes[0],
      id: `file:${i}`,
      path: `pkg${i % 10}/${i}.ts`,
      kind: "file",
      subsystem: `pkg${i % 10}`,
    })),
    edges: [],
  };
  const overview = orbitLayout(big);
  assert(overview.aggregated);
  assert.equal(overview.bodies.length, 10);
  assert.equal(
    overview.bodies.reduce((n, b) => n + b.count, 0),
    2000,
  );
  const detail = orbitLayout(big, "pkg1");
  assert(!detail.aggregated);
  assert.equal(detail.bodies.length, 200);
});
test("large single region uses disjoint bounded pages with stable colors", () => {
  const big = {
    ...data,
    files: 900,
    nodes: Array.from({ length: 900 }, (_, i) => ({
      ...data.nodes[0],
      id: `f${i}`,
      path: `src/${i}.ts`,
      kind: "file",
      subsystem: "src",
    })),
    edges: [],
  };
  const first = orbitLayout(big, "src", 0),
    last = orbitLayout(big, "src", 2);
  assert.equal(first.total, 900);
  assert.equal(first.pages, 3);
  assert.equal(first.bodies.length, 350);
  assert.equal(last.bodies.length, 200);
  assert(!last.bodies.some((b) => first.bodies.some((a) => a.id === b.id)));
  assert.equal(first.bodies[0].color, orbitLayout(big).bodies[0].color);
});
