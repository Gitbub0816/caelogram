import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEmphasis,
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

test("filters re-lay-out the galaxy instead of leaving holes in it", () => {
  const payload = synthetic(600, 900);
  const all = buildGalaxy(payload, defaultFilters);
  assert.equal(all.bodies.length, 600);
  assert.equal(all.total, 600);

  const region = all.regions[0].name;
  const byRegion = buildGalaxy(payload, {
    ...defaultFilters,
    regions: [region],
  });
  assert.equal(
    byRegion.bodies.length,
    all.bodies.filter((b) => b.region === region).length,
  );
  assert(byRegion.bodies.every((b) => b.region === region));
  assert.equal(byRegion.total, 600);
  // The survivors are re-ranked, so the filtered view still fills a disk from
  // core to rim rather than keeping the gaps the hidden files left behind.
  const depths = byRegion.bodies.map((b) => b.depth).sort((a, b) => a - b);
  assert.equal(depths[0], 0);
  assert.equal(depths.at(-1), 1);
  const moved = byRegion.bodies.filter(
    (b) => all.byPath.get(b.path)!.depth !== b.depth,
  );
  assert(moved.length > 0, "filtering should re-arrange the remaining bodies");
  // A file's nature still comes from the whole repository, not from the view.
  for (const b of byRegion.bodies) {
    const before = all.byPath.get(b.path)!;
    assert.equal(b.bodyClass, before.bodyClass);
    assert.equal(b.incoming, before.incoming);
  }
  // Only relationships between visible files survive, re-indexed to match.
  for (const e of byRegion.edges) {
    assert(byRegion.bodies[e.from] && byRegion.bodies[e.to]);
    assert.equal(byRegion.bodies[e.from].region, region);
    assert.equal(byRegion.bodies[e.to].region, region);
  }

  const important = buildGalaxy(payload, {
    ...defaultFilters,
    minIncoming: 2,
  });
  assert(
    important.bodies.every((b) => b.incoming >= 2) &&
      important.bodies.length ===
        all.bodies.filter((b) => b.incoming >= 2).length,
  );

  const hub = [...all.bodies].sort((a, b) => b.incoming - a.incoming)[0];
  const focused = buildGalaxy(payload, {
    ...defaultFilters,
    focus: hub.path,
    depth: 1,
  });
  assert(focused.byPath.has(hub.path));
  assert.equal(
    focused.bodies.length,
    new Set(all.adjacency.get(hub.index) ?? []).size + 1,
  );
});

test("relationship filters change the web without hiding components", () => {
  const payload = payloadFromMapData(mapData);
  const all = buildGalaxy(payload, defaultFilters);
  assert(all.edges.length > 0);
  const hidden = buildGalaxy(payload, { ...defaultFilters, links: "none" });
  assert.equal(hidden.edges.length, 0);
  assert.equal(hidden.bodies.length, all.bodies.length);
  const kind = all.edges[0].kind;
  const oneKind = buildGalaxy(payload, {
    ...defaultFilters,
    edgeKinds: [kind],
  });
  assert(oneKind.edges.every((e) => e.kind === kind));
  assert.equal(
    oneKind.edges.length,
    all.edges.filter((e) => e.kind === kind).length,
  );
  assert.equal(oneKind.bodies.length, all.bodies.length);
});

test("search and task relevance dim rather than remove", () => {
  const galaxy = buildGalaxy(synthetic(300, 400), defaultFilters);
  const none = applyEmphasis(galaxy, "", []);
  assert(none.every((v) => v === 1));
  const hub = galaxy.bodies[0];
  const searched = applyEmphasis(galaxy, hub.name, []);
  assert.equal(searched.length, galaxy.bodies.length);
  assert.equal(searched[hub.index], 1);
  assert(
    galaxy.bodies.some((b) => searched[b.index] < 1),
    "non-matching bodies should dim",
  );
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
