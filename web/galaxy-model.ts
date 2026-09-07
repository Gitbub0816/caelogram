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
  bytes: number;
};
export type Filters = {
  regions: string[]; // empty = every region
  categories: Category[]; // empty = every category
  minIncoming: number;
  edgeKinds: string[]; // empty = every kind
  focus: string; // path of the focused file, "" = whole galaxy
  depth: number; // hops from the focus that stay visible
  colorMode: "region" | "category" | "importance";
};
export const defaultFilters: Filters = {
  regions: [],
  categories: [],
  minIncoming: 0,
  edgeKinds: [],
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
  "#e8c98d",
  "#7fb4ee",
  "#d8b07c",
  "#a8c9e8",
  "#c8a06f",
  "#8fd0e0",
  "#efe0b8",
  "#6f9fd8",
  "#bfa88c",
  "#a6bcd2",
  "#d9c4a0",
  "#87a6c4",
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
};
// One pass over the payload produces every derived property the renderer and
// the filter panel need. Expensive enough to memoise on the payload identity.
export function buildGalaxy(data: GalaxyPayload): Galaxy {
  const n = data.nodes.length;
  const incoming = new Array<number>(n).fill(0),
    outgoing = new Array<number>(n).fill(0);
  const adjacency = new Map<number, number[]>();
  const edges = data.edges.map(([from, to, k]) => {
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
  // mature one does not turn every shared util into one.
  const sorted = [...incoming].sort((a, b) => b - a);
  const quantile = (f: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] ?? 0;
  const maxIncoming = sorted[0] ?? 0;
  const starCut = Math.max(3, Math.min(maxIncoming, quantile(0.008)));
  const planetCut = Math.max(
    2,
    Math.min(starCut - 1 || 1, Math.max(2, quantile(0.07))),
  );
  const regionCounts = new Map<string, number>();
  for (const node of data.nodes) {
    const r = regionOf(node.path);
    regionCounts.set(r, (regionCounts.get(r) ?? 0) + 1);
  }
  const regions = [...regionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count], i) => ({
      name,
      count,
      color: regionPalette[i % regionPalette.length],
    }));
  const regionIndex = new Map(regions.map((r, i) => [r.name, i] as const));
  // Spiral geometry. Arms come from the largest subsystems; smaller ones share
  // an arm at a phase offset so the disk stays readable rather than crowded.
  const arms = Math.min(6, Math.max(2, Math.min(regions.length, 5)));
  const extent = 16 + Math.sqrt(n) * 1.5;
  const TWIST = 6.4;
  const importanceOf = (i: number) => incoming[i] * 1 + outgoing[i] * 0.28;
  // Radius comes from *rank*, not from the raw score. Import counts are heavily
  // skewed, so a proportional radius would pin almost every file to the rim;
  // ranking spreads the disk evenly with the hubs still holding the core.
  const rank = new Float64Array(n);
  const ordered = data.nodes
    .map((node, i) => i)
    .sort(
      (a, b) =>
        importanceOf(b) - importanceOf(a) ||
        hash(data.nodes[a].path) - hash(data.nodes[b].path),
    );
  ordered.forEach((i, position) => {
    rank[i] = n > 1 ? position / (n - 1) : 0;
  });
  const categoryCounts = new Map<Category, number>();
  const bodies: Body[] = data.nodes.map((node, i) => {
    const region = regionOf(node.path),
      ri = regionIndex.get(region) ?? 0;
    const category = categorize(node.path);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
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
    const t = rank[i];
    const jitter = rng();
    const r = extent * Math.pow(t, 0.42) * (0.86 + jitter * 0.26) + 0.9;
    const arm = ri % arms;
    const sharedPhase = Math.floor(ri / arms) * 0.55;
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
      index: i,
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
      bytes: node.bytes,
    };
  });
  return {
    bodies,
    byPath: new Map(bodies.map((b) => [b.path, b] as const)),
    edges,
    adjacency,
    regions,
    categories: [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    kinds: data.kinds,
    extent,
    cuts: { star: starCut, planet: planetCut },
    maxIncoming,
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
    const mix = c[i].map((v, k) => v + (c[i + 1][k] - v) * f);
    return `#${mix
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  }
  return body.color;
}
// Which bodies survive the current filters, and — separately — which are merely
// dimmed. Focus mode keeps the neighbourhood bright and everything else faint.
export function applyFilters(
  galaxy: Galaxy,
  filters: Filters,
  search: string,
  relevant: string[],
): { visible: Uint8Array; emphasis: Float32Array } {
  const n = galaxy.bodies.length;
  const visible = new Uint8Array(n);
  const emphasis = new Float32Array(n).fill(1);
  const regions = new Set(filters.regions),
    categories = new Set(filters.categories);
  const query = search.trim().toLowerCase();
  const relevantSet = new Set(relevant);
  let near: Set<number> | undefined;
  if (filters.focus) {
    const start = galaxy.byPath.get(filters.focus);
    if (start) {
      near = new Set([start.index]);
      let frontier = [start.index];
      for (let d = 0; d < filters.depth; d++) {
        const next: number[] = [];
        for (const i of frontier)
          for (const j of galaxy.adjacency.get(i) ?? [])
            if (!near.has(j)) {
              near.add(j);
              next.push(j);
            }
        frontier = next;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const b = galaxy.bodies[i];
    const passes =
      (!regions.size || regions.has(b.region)) &&
      (!categories.size || categories.has(b.category)) &&
      b.incoming >= filters.minIncoming &&
      (!near || near.has(i));
    visible[i] = passes ? 1 : 0;
    if (!passes) continue;
    const matching = !query || b.path.toLowerCase().includes(query);
    const related = !relevantSet.size || relevantSet.has(b.path);
    emphasis[i] = matching && related ? 1 : 0.28;
  }
  return { visible, emphasis };
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
