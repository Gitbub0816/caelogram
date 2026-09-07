// Derives the galaxy from a whole-repository payload: what each file *is*
// (debris, moon, planet, star) follows from how relationally important it is,
// and where it sits follows from that same importance — hubs in the core,
// leaves out on the rim.
export type GalaxyNode = {
  path: string;
  name: string;
  symbols: number;
  bytes: number;
  excluded: boolean;
};
export type GalaxyPayload = {
  id: string;
  name: string;
  branch: string;
  revision: string;
  files: number;
  symbols: number;
  relationships: number;
  nodes: GalaxyNode[];
  edges: [number, number, number][];
  kinds: string[];
  truncated: boolean;
};
export type BodyClass = "star" | "planet" | "moon" | "debris";
export type Category =
  "code" | "test" | "config" | "docs" | "style" | "asset" | "other";
export type Body = {
  index: number;
  path: string;
  name: string;
  region: string;
  directory: string;
  category: Category;
  incoming: number;
  outgoing: number;
  importance: number;
  bodyClass: BodyClass;
  x: number;
  y: number;
  z: number;
  radius: number;
  color: string;
  depth: number; // 0 at the galactic core, 1 at the rim
  bytes: number;
};
export type Filters = {
  regions: string[]; // empty = every region
  categories: Category[]; // empty = every category
  minIncoming: number;
  edgeKinds: string[]; // empty = every kind
  links: "all" | "selected" | "none"; // how much of the relationship web to draw
  minConfidence: number; // 0-1, drops low-evidence relationships
  focus: string; // path of the focused file, "" = whole galaxy
  depth: number; // hops from the focus that stay visible
  colorMode: "region" | "category" | "importance";
};
export const defaultFilters: Filters = {
  regions: [],
  categories: [],
  minIncoming: 0,
  edgeKinds: [],
  links: "all",
  minConfidence: 0,
  focus: "",
  depth: 2,
  colorMode: "region",
};
export const classLabels: Record<BodyClass, string> = {
  star: "Star — a hub the repository leans on",
  planet: "Planet — several consumers",
  moon: "Moon — one or two consumers",
  debris: "Debris — no resolved relationships",
};
// Warm gold through cool blue: the two halves of the Caelogram mark.
export const regionPalette = [
  "#f0c977",
  "#6fa8f0",
  "#e08a6a",
  "#66c9c2",
  "#c98ae0",
  "#e8d79a",
  "#8f9ff0",
  "#e0705f",
  "#7fd08a",
  "#d47fa8",
  "#b6a0f0",
  "#e6a94f",
  "#5fc0e8",
  "#c7d47f",
  "#f08fb8",
  "#9fb8d4",
];
export const categoryColors: Record<Category, string> = {
  code: "#e8c98d",
  test: "#8fd0e0",
  config: "#c8a06f",
  docs: "#efe0b8",
  style: "#c9a3d8",
  asset: "#a6bcd2",
  other: "#9b968c",
};
export const hash = (s: string) =>
  [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 1);
const random = (seed: number) => {
  // Deterministic per-path jitter, so the galaxy never reshuffles on re-render.
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
};
const CODE =
  /\.(m|c)?(t|j)sx?$|\.(py|go|rs|java|cs|rb|php|c|cc|cpp|h|hpp|swift|kt|kts|scala|sh|sql|vue|svelte)$/i;
const CONFIG =
  /\.(json|jsonc|ya?ml|toml|ini|env|lock|cfg|conf|properties|gradle|xml|csproj|sln)$|(^|\/)(dockerfile|makefile|\.[^/]+rc)$/i;
const DOCS = /\.(md|mdx|txt|rst|adoc)$/i;
const STYLE = /\.(css|scss|sass|less|styl)$/i;
const ASSET =
  /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf)$/i;
const TEST = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[^/]+$/i;
export function categorize(path: string): Category {
  if (TEST.test(path)) return "test";
  if (STYLE.test(path)) return "style";
  if (ASSET.test(path)) return "asset";
  if (DOCS.test(path)) return "docs";
  if (CONFIG.test(path)) return "config";
  if (CODE.test(path)) return "code";
  return "other";
}
export const regionOf = (path: string) => {
  const parts = path.split("/");
  return parts.length > 1 ? parts[0] : "(root)";
};
export const directoryOf = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "(root)" : path.slice(0, i);
};
export type Galaxy = {
  bodies: Body[];
  byPath: Map<string, Body>;
  edges: { from: number; to: number; kind: string }[];
  adjacency: Map<number, number[]>;
  regions: { name: string; count: number; color: string }[];
  categories: { name: Category; count: number }[];
  kinds: string[];
  extent: number;
  cuts: { star: number; planet: number };
  maxIncoming: number;
  total: number; // files in the repository, before filtering
};
// Builds the galaxy for whatever the filters leave visible.
//
// Two things are deliberately separated. A file's *nature* — debris, moon,
// planet, star — comes from its relationships across the whole repository, so
// looking away from part of the code never demotes a hub. Its *position* is
// ranked among the files currently on screen, so a filtered view spreads across
// the whole disk and the survivors stay meaningful relative to one another
// rather than leaving a half-empty ring behind.
export function buildGalaxy(
  data: GalaxyPayload,
  filters: Filters = defaultFilters,
): Galaxy {
  const n = data.nodes.length;
  const incoming = new Array<number>(n).fill(0),
    outgoing = new Array<number>(n).fill(0);
  const adjacency = new Map<number, number[]>();
  const allEdges = data.edges.map(([from, to, k]) => {
    incoming[to]++;
    outgoing[from]++;
    for (const [a, b] of [
      [from, to],
      [to, from],
    ]) {
      const list = adjacency.get(a);
      if (list) list.push(b);
      else adjacency.set(a, [b]);
    }
    return { from, to, kind: data.kinds[k] ?? "imports" };
  });
  // Thresholds adapt to the repository: a small project still gets a star, a
  // mature one does not turn every shared util into one. Computed over every
  // file so they hold steady as the view narrows.
  const sorted = [...incoming].sort((a, b) => b - a);
  const quantile = (f: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] ?? 0;
  const maxIncoming = sorted[0] ?? 0;
  const starCut = Math.max(3, Math.min(maxIncoming, quantile(0.008)));
  const planetCut = Math.max(
    2,
    Math.min(starCut - 1 || 1, Math.max(2, quantile(0.07))),
  );
  // Region and category lists describe the whole repository, so the filter
  // chips never vanish just because they are switched off.
  const regionCounts = new Map<string, number>();
  const categoryCounts = new Map<Category, number>();
  const categoryOf = new Array<Category>(n);
  for (let i = 0; i < n; i++) {
    const r = regionOf(data.nodes[i].path);
    regionCounts.set(r, (regionCounts.get(r) ?? 0) + 1);
    const c = (categoryOf[i] = categorize(data.nodes[i].path));
    categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
  }
  const regions = [...regionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count], i) => ({
      name,
      count,
      color: regionPalette[i % regionPalette.length],
    }));
  const regionIndex = new Map(regions.map((r, i) => [r.name, i] as const));
  // --- membership -------------------------------------------------------
  const wanted = new Set(filters.regions),
    wantedCategories = new Set(filters.categories);
  let near: Set<number> | undefined;
  if (filters.focus) {
    const start = data.nodes.findIndex((x) => x.path === filters.focus);
    if (start >= 0) {
      near = new Set([start]);
      let frontier = [start];
      for (let d = 0; d < filters.depth; d++) {
        const next: number[] = [];
        for (const i of frontier)
          for (const j of adjacency.get(i) ?? [])
            if (!near.has(j)) {
              near.add(j);
              next.push(j);
            }
        frontier = next;
      }
    }
  }
  const members: number[] = [];
  for (let i = 0; i < n; i++)
    if (
      (!wanted.size || wanted.has(regionOf(data.nodes[i].path))) &&
      (!wantedCategories.size || wantedCategories.has(categoryOf[i])) &&
      incoming[i] >= filters.minIncoming &&
      (!near || near.has(i))
    )
      members.push(i);
  const slot = new Map(members.map((i, position) => [i, position] as const));
  // --- spiral geometry over the visible set ------------------------------
  const visibleRegions = [
    ...new Set(members.map((i) => regionOf(data.nodes[i].path))),
  ].sort((a, b) => (regionIndex.get(a) ?? 0) - (regionIndex.get(b) ?? 0));
  const armOf = new Map(visibleRegions.map((r, i) => [r, i] as const));
  // A spiral needs at least two arms to fill the disk. With one subsystem on
  // screen its files are split across both, so filtering down to a single
  // region still yields a whole galaxy rather than a half-empty arc.
  const armsPerRegion = visibleRegions.length === 1 ? 2 : 1;
  const arms = Math.min(
    6,
    Math.max(2, Math.min(visibleRegions.length * armsPerRegion, 5)),
  );
  const extent = 16 + Math.sqrt(Math.max(1, members.length)) * 1.5;
  const TWIST = 6.4;
  const importanceOf = (i: number) => incoming[i] * 1 + outgoing[i] * 0.28;
  // Radius comes from *rank*, not from the raw score. Import counts are heavily
  // skewed, so a proportional radius would pin almost every file to the rim;
  // ranking spreads the disk evenly with the hubs still holding the core. The
  // ranking runs over the visible files, which is what re-arranges the galaxy
  // when a filter changes.
  const rank = new Map<number, number>();
  [...members]
    .sort(
      (a, b) =>
        importanceOf(b) - importanceOf(a) ||
        hash(data.nodes[a].path) - hash(data.nodes[b].path),
    )
    .forEach((i, position) =>
      rank.set(i, members.length > 1 ? position / (members.length - 1) : 0),
    );
  const bodies: Body[] = members.map((i, position) => {
    const node = data.nodes[i];
    const region = regionOf(node.path),
      ri = regionIndex.get(region) ?? 0;
    const category = categoryOf[i];
    const importance = importanceOf(i);
    const bodyClass: BodyClass =
      incoming[i] >= starCut
        ? "star"
        : incoming[i] >= planetCut
          ? "planet"
          : incoming[i] + outgoing[i] > 0
            ? "moon"
            : "debris";
    const rng = random(hash(node.path));
    // t = 0 at the galactic core (most connected), 1 at the rim. The fractional
    // power keeps areal density roughly even while still opening out the core
    // enough that the handful of stars there do not collide.
    const t = rank.get(i) ?? 0;
    const jitter = rng();
    const r = extent * Math.pow(t, 0.42) * (0.86 + jitter * 0.26) + 0.9;
    const base = armOf.get(region) ?? 0;
    const arm =
      (base * armsPerRegion + (hash(node.path) % armsPerRegion)) % arms;
    const sharedPhase = Math.floor(base / arms) * 0.55;
    const spread = (rng() - 0.5) * (0.2 + (r / extent) * 0.34);
    const theta =
      (arm / arms) * Math.PI * 2 +
      sharedPhase +
      (r / extent) * TWIST +
      spread +
      rng() * 0.12;
    // Thick central bulge flattening into a thin outer disk.
    const thickness = extent * 0.16 * (1 - 0.72 * Math.min(1, r / extent));
    const radius =
      bodyClass === "star"
        ? 0.85 + Math.log2(incoming[i] + 1) * 0.24
        : bodyClass === "planet"
          ? 0.44 + Math.log2(incoming[i] + 1) * 0.16
          : bodyClass === "moon"
            ? 0.27 + Math.log2(incoming[i] + outgoing[i] + 1) * 0.05
            : 0.13;
    return {
      index: position,
      path: node.path,
      name: node.name,
      region,
      directory: directoryOf(node.path),
      category,
      incoming: incoming[i],
      outgoing: outgoing[i],
      importance,
      bodyClass,
      x: Math.cos(theta) * r,
      y: (rng() - 0.5) * 2 * thickness,
      z: Math.sin(theta) * r,
      radius,
      color: regions[ri]?.color ?? regionPalette[0],
      depth: t,
      bytes: node.bytes,
    };
  });
  // Relationships among the survivors, honouring the link filters.
  const wantedKinds = new Set(filters.edgeKinds);
  const edges =
    filters.links === "none"
      ? []
      : allEdges.flatMap((e) => {
          const from = slot.get(e.from),
            to = slot.get(e.to);
          if (from === undefined || to === undefined) return [];
          if (wantedKinds.size && !wantedKinds.has(e.kind)) return [];
          return [{ from, to, kind: e.kind }];
        });
  const visibleAdjacency = new Map<number, number[]>();
  for (const e of edges)
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ]) {
      const list = visibleAdjacency.get(a);
      if (list) list.push(b);
      else visibleAdjacency.set(a, [b]);
    }
  return {
    bodies,
    byPath: new Map(bodies.map((b) => [b.path, b] as const)),
    edges,
    adjacency: visibleAdjacency,
    regions,
    categories: [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    kinds: data.kinds,
    extent,
    cuts: { star: starCut, planet: planetCut },
    maxIncoming,
    total: n,
  };
}
export function colorFor(
  body: Body,
  galaxy: Galaxy,
  mode: Filters["colorMode"],
) {
  if (mode === "category") return categoryColors[body.category];
  if (mode === "importance") {
    const t = Math.min(1, body.incoming / Math.max(1, galaxy.maxIncoming));
    // Cool blue (peripheral) to hot gold (central).
    const c = [
      [0.42, 0.62, 0.85],
      [0.65, 0.78, 0.88],
      [0.93, 0.83, 0.58],
      [1.0, 0.86, 0.42],
    ];
    const p = t * (c.length - 1),
      i = Math.min(c.length - 2, Math.floor(p)),
      f = p - i;
    return rgb(c[i].map((v, k) => v + (c[i + 1][k] - v) * f));
  }
  // Subsystem hue, warmed toward the core and cooled toward the rim so the disk
  // carries a Milky Way gradient without losing which subsystem a body is in.
  return rgb(shift(body.color, body.depth));
}
const CORE = [1.0, 0.83, 0.55],
  RIM = [0.62, 0.76, 1.0];
// Blends a subsystem colour toward the warm core or the cool rim.
export function shift(hex: string, depth: number, strength = 0.34) {
  const base = [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
  const target = depth < 0.5 ? CORE : RIM;
  const weight = Math.abs(depth - 0.5) * 2 * strength;
  return base.map((v, i) => v + (target[i] - v) * weight);
}
const rgb = (c: number[]) =>
  `#${c
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
// Search and task relevance never remove a body, they only dim the rest.
export function applyEmphasis(
  galaxy: Galaxy,
  search: string,
  relevant: string[],
): Float32Array {
  const emphasis = new Float32Array(galaxy.bodies.length).fill(1);
  const query = search.trim().toLowerCase();
  const relevantSet = new Set(relevant);
  if (!query && !relevantSet.size) return emphasis;
  for (const b of galaxy.bodies) {
    const matching = !query || b.path.toLowerCase().includes(query);
    const related = !relevantSet.size || relevantSet.has(b.path);
    emphasis[b.index] = matching && related ? 1 : 0.28;
  }
  return emphasis;
}
// The sample repository and any locally paged map already carry full nodes and
// edges; reshape them into the same payload the galaxy endpoint returns.
export function payloadFromMapData(data: {
  id: string;
  name: string;
  branch: string;
  revision: string;
  files: number;
  symbols: number;
  relationships: number;
  nodes: {
    id: string;
    name: string;
    path: string;
    kind: string;
    exclusionReason?: string;
    bytes?: number;
  }[];
  edges: { from: string; to: string; kind: string }[];
  visibleFiles?: number;
}): GalaxyPayload {
  const files = data.nodes.filter((n) => n.kind === "file");
  const order = new Map(files.map((n, i) => [n.path, i] as const));
  const symbols = new Map<string, number>();
  for (const n of data.nodes)
    if (n.kind !== "file") symbols.set(n.path, (symbols.get(n.path) ?? 0) + 1);
  const kinds: string[] = [];
  const edges: [number, number, number][] = [];
  for (const e of data.edges) {
    if (e.kind === "contains") continue;
    const from = order.get(e.from),
      to = order.get(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    let k = kinds.indexOf(e.kind);
    if (k < 0) k = kinds.push(e.kind) - 1;
    edges.push([from, to, k]);
  }
  return {
    id: data.id,
    name: data.name,
    branch: data.branch,
    revision: data.revision,
    files: data.files,
    symbols: data.symbols,
    relationships: data.relationships,
    nodes: files.map((n) => ({
      path: n.path,
      name: n.name,
      symbols: symbols.get(n.path) ?? 0,
      bytes: n.bytes ?? 0,
      excluded: !!n.exclusionReason,
    })),
    edges,
    kinds,
    truncated:
      data.visibleFiles !== undefined && data.visibleFiles < data.files,
  };
}
