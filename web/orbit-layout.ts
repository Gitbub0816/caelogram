import type { MapData, Node } from "./Galaxy";
export type Body = {
  id: string;
  name: string;
  node?: Node;
  region: string;
  count: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  incoming: number;
  color: string;
};
const palette = [
  "#d9b572",
  "#be8570",
  "#c4c0b7",
  "#9d9e84",
  "#cfa493",
  "#ae8d70",
  "#c1ac7c",
  "#b5a1ac",
];
export const hash = (s: string) =>
  [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 1);
export function orbitLayout(
  data: MapData,
  region?: string,
  page = 0,
): { bodies: Body[]; aggregated: boolean; total: number; pages: number } {
  const all = data.nodes.filter(
    (n) => n.kind === "file" && (!region || n.subsystem === region),
  );
  const total = all.length;
  const files = region ? all.slice(page * 350, (page + 1) * 350) : all;
  const allRegions = [
    ...new Set(
      data.nodes.filter((n) => n.kind === "file").map((n) => n.subsystem),
    ),
  ].sort();
  const regions = [...new Set(files.map((n) => n.subsystem))].sort();
  const counts = new Map<string, number>();
  for (const e of data.edges)
    if (e.kind !== "contains") counts.set(e.to, (counts.get(e.to) || 0) + 1);
  const aggregated = files.length > 350 && !region;
  const bodies: Body[] = [];
  regions.forEach((r, ri) => {
    const members = files
      .filter((n) => n.subsystem === r)
      .sort((a, b) => a.path.localeCompare(b.path));
    const theta = ri * 2.399963,
      dist = regions.length === 1 ? 0 : 5 + Math.sqrt(ri) * 5;
    const cx = Math.cos(theta) * dist,
      cz = Math.sin(theta) * dist;
    if (aggregated) {
      bodies.push({
        id: `region:${r}`,
        name: r,
        region: r,
        count: members.length,
        x: cx,
        y: 0,
        z: cz,
        radius: 1 + Math.log2(members.length + 1) * 0.3,
        incoming: members.reduce((sum, n) => sum + (counts.get(n.id) || 0), 0),
        color: palette[allRegions.indexOf(r) % palette.length],
      });
      return;
    }
    members.forEach((n, i) => {
      const a = i * 2.399963 + theta,
        d = members.length === 1 ? 0 : 1.6 + Math.sqrt(i) * 1.6,
        incoming = counts.get(n.id) || 0;
      bodies.push({
        id: n.id,
        name: n.name,
        node: n,
        region: r,
        count: 1,
        x: cx + Math.cos(a) * d,
        y: ((hash(n.path) % 100) / 100 - 0.5) * 2.5,
        z: cz + Math.sin(a) * d,
        radius: 0.42 + Math.log2(incoming + 1) * 0.28,
        incoming,
        color: palette[allRegions.indexOf(r) % palette.length],
      });
    });
  });
  return {
    bodies,
    aggregated,
    total,
    pages: region ? Math.ceil(total / 350) : 1,
  };
}
