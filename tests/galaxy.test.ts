import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFilters,
  buildGalaxy,
  categorize,
  defaultFilters,
  payloadFromMapData,
  type GalaxyPayload,
} from "../web/galaxy-model.js";
import { demoRepository } from "../src/demo.js";

const demo = demoRepository();
const mapData = {
  ...demo,
  nodes: demo.graph.nodes,
  edges: demo.graph.edges,
  files: demo.graph.files.length,
  symbols: demo.graph.nodes.filter((n) => n.kind !== "file").length,
  relationships: demo.graph.edges.filter((e) => e.kind !== "contains").length,
} as unknown as Parameters<typeof payloadFromMapData>[0];

const synthetic = (files: number, links: number): GalaxyPayload => {
  const nodes = Array.from({ length: files }, (_, i) => ({
    path: `pkg${i % 6}/mod${i}.ts`,
    name: `mod${i}.ts`,
    symbols: 0,
    bytes: 100 + i,
    excluded: false,
  }));
  // Deterministic skew: low indices attract most of the imports.
  const edges: [number, number, number][] = [];
  let seed = 3;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < links; i++) {
    const to = Math.floor(Math.pow(rnd(), 4) * files),
      from = Math.floor(rnd() * files);
    if (from !== to) edges.push([from, to, 0]);
  }
  return {
    id: "s",
    name: "acme/s",
    branch: "main",
    revision: "abc",
    files,
    symbols: 0,
    relationships: edges.length,
    nodes,
    edges,
    kinds: ["imports"],
    truncated: false,
  };
};

test("every indexed file becomes a body, and the layout is deterministic", () => {
  const payload = payloadFromMapData(mapData);
  const a = buildGalaxy(payload),
    b = buildGalaxy(payload);
  assert.equal(a.bodies.length, payload.nodes.length);
  assert.deepEqual(
    a.bodies.map((x) => [x.path, x.x, x.y, x.z]),
    b.bodies.map((x) => [x.path, x.x, x.y, x.z]),
  );
  assert.equal(new Set(a.bodies.map((x) => x.path)).size, a.bodies.length);
});

test("body type follows relational weight and the core holds the hubs", () => {
  const galaxy = buildGalaxy(synthetic(1200, 1800));
  const stars = galaxy.bodies.filter((b) => b.bodyClass === "star");
  const debris = galaxy.bodies.filter((b) => b.bodyClass === "debris");
  assert(stars.length > 0, "a skewed repository should produce stars");
  assert(debris.length > 0, "unreferenced files should be debris");
  for (const s of stars) assert(s.incoming >= galaxy.cuts.star);
  for (const d of debris) assert.equal(d.incoming + d.outgoing, 0);
  // Hubs sit closer to the galactic core than the unreferenced rim.
  const mean = (bs: typeof stars) =>
    bs.reduce((n, b) => n + Math.hypot(b.x, b.z), 0) / bs.length;
  assert(mean(stars) < mean(debris));
  // Radii, and therefore the disk, stay inside the declared extent.
  for (const b of galaxy.bodies)
    assert(Math.hypot(b.x, b.z) <= galaxy.extent * 1.2);
});

test("filters narrow by subsystem, importance, type and neighbourhood", () => {
  const galaxy = buildGalaxy(synthetic(600, 900));
  const all = applyFilters(galaxy, defaultFilters, "", []);
  assert.equal(
    all.visible.reduce((n, v) => n + v, 0),
    galaxy.bodies.length,
  );
  const region = galaxy.regions[0].name;
  const byRegion = applyFilters(
    galaxy,
    { ...defaultFilters, regions: [region] },
    "",
    [],
  );
  assert.equal(
    byRegion.visible.reduce((n, v) => n + v, 0),
    galaxy.bodies.filter((b) => b.region === region).length,
  );
  const important = applyFilters(
    galaxy,
    { ...defaultFilters, minIncoming: 2 },
    "",
    [],
  );
  assert(
    galaxy.bodies.every(
      (b) => (important.visible[b.index] === 1) === b.incoming >= 2,
    ),
  );
  const hub = [...galaxy.bodies].sort((a, b) => b.incoming - a.incoming)[0];
  const focused = applyFilters(
    galaxy,
    { ...defaultFilters, focus: hub.path, depth: 1 },
    "",
    [],
  );
  const neighbours = new Set(galaxy.adjacency.get(hub.index) ?? []);
  assert.equal(focused.visible[hub.index], 1);
  assert.equal(
    focused.visible.reduce((n, v) => n + v, 0),
    neighbours.size + 1,
  );
  // A search term dims the rest rather than removing it.
  const searched = applyFilters(galaxy, defaultFilters, hub.name, []);
  assert.equal(searched.emphasis[hub.index], 1);
});

test("file categories separate tests, config and assets from source", () => {
  assert.equal(categorize("src/payments/gateway.ts"), "code");
  assert.equal(categorize("tests/gateway.test.ts"), "test");
  assert.equal(categorize("src/__tests__/x.ts"), "test");
  assert.equal(categorize("package.json"), "config");
  assert.equal(categorize("Dockerfile"), "config");
  assert.equal(categorize("README.md"), "docs");
  assert.equal(categorize("web/style.css"), "style");
  assert.equal(categorize("web/public/logo.png"), "asset");
});
