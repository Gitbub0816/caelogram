import { useMemo, useState, useRef } from "react";
export interface Node {
  id: string;
  name: string;
  path: string;
  kind: string;
  start: number;
  end: number;
  subsystem: string;
  exported: boolean;
  analysis?: string;
  exclusionReason?: string;
  bytes?: number;
}
export interface Edge {
  from: string;
  to: string;
  kind: string;
  evidence: string;
  confidence: number;
  revision: string;
}
export interface MapData {
  nextCursor?: string | null;
  visibleFiles?: number;
  id: string;
  name: string;
  branch: string;
  revision: string;
  nodes: Node[];
  edges: Edge[];
  files: number;
  symbols: number;
  relationships: number;
  indexedAt: string;
  warnings: string[];
  status: string;
}
export const colors = [
  "#e5c994",
  "#c6c2b9",
  "#bfa784",
  "#eee2bf",
  "#aaaca6",
  "#d4ba93",
  "#a99370",
  "#e6e4dc",
  "#96978f",
  "#f1cf90",
];
const hash = (s: string) =>
  [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 1);
export function Galaxy({
  data,
  selected,
  onSelect,
  relevant,
  search = "",
  compact = false,
}: {
  data: MapData;
  selected: string;
  onSelect: (id: string) => void;
  relevant: string[];
  search?: string;
  compact?: boolean;
}) {
  const [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(-12),
    [offset, setOffset] = useState({ x: 0, y: 0 }),
    [hover, setHover] = useState(""),
    [regionFocus, setRegionFocus] = useState("");
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  const { bodies, regions } = useMemo(() => {
    const files = data.nodes.filter((n) => n.kind === "file");
    const groups = [...new Set(files.map((n) => n.subsystem))].sort();
    // Absolute population affects physical extent: never normalize a tiny repo to fill the canvas.
    const spread = Math.min(280, 65 + Math.sqrt(files.length) * 28);
    const regions = groups.map((name, i) => {
      const a = i * 2.39996;
      const r =
        groups.length === 1 ? 0 : spread * Math.sqrt((i + 1) / groups.length);
      return {
        name,
        x: 500 + Math.cos(a) * r,
        y: 355 + Math.sin(a) * r * 0.68,
        color: colors[i % colors.length],
      };
    });
    const bodies = files.map((n) => {
      const region = regions.find((r) => r.name === n.subsystem)!;
      const siblings = files.filter((f) => f.subsystem === n.subsystem);
      const i = siblings.indexOf(n);
      const a = ((hash(n.path) % 360) * Math.PI) / 180;
      const r = 18 + Math.sqrt(i + 1) * 23;
      const incoming = data.edges.filter(
        (e) => e.to === n.id && e.kind !== "contains",
      ).length;
      return {
        ...n,
        x: region.x + Math.cos(a) * r,
        y: region.y + Math.sin(a) * r * 0.62,
        r: 3.5 + Math.min(8, Math.log2(incoming + 1) * 2),
        incoming,
        color: region.color,
      };
    });
    return { bodies, regions };
  }, [data]);
  const clusterMode = data.files > 200 && !regionFocus;
  const shownBodies = regionFocus
    ? bodies.filter((b) => b.subsystem === regionFocus)
    : bodies;
  const positions = new Map(shownBodies.map((n) => [n.id, n]));
  const related = new Set(relevant);
  const visible = hover || selected;
  const picked = positions.get(visible);
  return (
    <div className={"galaxy " + (compact ? "compact" : "")}>
      <svg
        viewBox="0 0 1000 710"
        aria-label={`Repository galaxy: ${data.files} files, ${data.relationships} module relationships. Tab to a file or use the component list.`}
        onWheel={(e) => {
          setZoom((z) =>
            Math.max(0.5, Math.min(3, z + (e.deltaY < 0 ? 0.1 : -0.1))),
          );
        }}
        onPointerDown={(e) => {
          if (
            e.target === e.currentTarget ||
            (e.target as SVGElement).tagName === "rect"
          ) {
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              ox: offset.x,
              oy: offset.y,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setOffset({
              x: drag.current.ox + (e.clientX - drag.current.x),
              y: drag.current.oy + (e.clientY - drag.current.y),
            });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="5" />
          </filter>
          <radialGradient id="body">
            <stop stopColor="#fff" />
            <stop offset=".3" stopColor="#eee9dc" />
            <stop offset="1" stopColor="currentColor" />
          </radialGradient>
        </defs>
        <rect width="1000" height="710" fill="transparent" />
        <g
          transform={`translate(${offset.x} ${offset.y}) translate(500 355) scale(${zoom}) rotate(${rotation}) translate(-500 -355)`}
        >
          {regions.map((region) => (
            <g key={region.name} className="region">
              <ellipse
                cx={region.x}
                cy={region.y}
                rx={70}
                ry={37}
                fill="none"
                stroke={region.color}
                strokeOpacity=".12"
                strokeDasharray="2 6"
              />
              <text
                x={region.x}
                y={region.y - 58}
                textAnchor="middle"
                transform={`rotate(${-rotation} ${region.x} ${region.y - 58})`}
                fill={region.color}
              >
                {region.name.replace("src/", "").toUpperCase()}
              </text>
            </g>
          ))}
          {!clusterMode &&
            data.edges
              .filter((e) => e.kind !== "contains")
              .map((e, i) => {
                const a = positions.get(e.from),
                  b = positions.get(e.to);
                if (!a || !b) return null;
                const active =
                  e.from === visible ||
                  e.to === visible ||
                  (related.has(e.from) && related.has(e.to));
                return (
                  <path
                    key={i}
                    d={`M${a.x},${a.y} Q${(a.x + b.x) / 2 + 30},${(a.y + b.y) / 2 - 45} ${b.x},${b.y}`}
                    fill="none"
                    stroke={e.kind === "tests" ? "#b8b4a6" : a.color}
                    strokeWidth={active ? 1.3 : 0.65}
                    strokeOpacity={active ? 0.72 : 0.12}
                    strokeDasharray={e.kind === "tests" ? "3 4" : undefined}
                  />
                );
              })}
          {clusterMode &&
            regions.map((region) => {
              const members = bodies.filter((n) => n.subsystem === region.name);
              const radius = 9 + Math.sqrt(members.length) * 2;
              return (
                <g
                  key={region.name + "-aggregate"}
                  role="button"
                  tabIndex={0}
                  aria-label={`${region.name}, region containing ${members.length} files`}
                  onClick={() => setRegionFocus(region.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setRegionFocus(region.name);
                    }
                  }}
                  className="body"
                >
                  <circle
                    cx={region.x}
                    cy={region.y}
                    r={radius + 10}
                    fill={region.color}
                    filter="url(#glow)"
                    opacity=".18"
                  />
                  <circle
                    cx={region.x}
                    cy={region.y}
                    r={radius}
                    fill="#171715"
                    stroke={region.color}
                    strokeOpacity=".8"
                  />
                  <text
                    x={region.x}
                    y={region.y + 4}
                    fill={region.color}
                    textAnchor="middle"
                    transform={`rotate(${-rotation} ${region.x} ${region.y})`}
                    className="body-label"
                  >
                    {members.length}
                  </text>
                </g>
              );
            })}
          {!clusterMode &&
            shownBodies.map((n) => {
              const active = related.has(n.path),
                dim =
                  (related.size > 0 && !active) ||
                  (!!search &&
                    !n.path.toLowerCase().includes(search.toLowerCase()));
              const chosen = selected === n.id;
              return (
                <g
                  key={n.id}
                  role="button"
                  tabIndex={compact ? -1 : 0}
                  aria-label={`${n.path}, ${n.incoming} incoming relationships${active ? ", task context" : ""}`}
                  onClick={() => onSelect(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(n.id);
                    }
                  }}
                  onFocus={() => setHover(n.id)}
                  onBlur={() => setHover("")}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover("")}
                  opacity={dim ? 0.2 : 1}
                  className="body"
                  style={{ color: n.color }}
                >
                  <title>
                    {n.path} · {n.incoming} incoming · coverage unknown
                  </title>
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={n.r * (active ? 3.6 : 2.6)}
                    fill={n.color}
                    opacity={active ? 0.25 : 0.16}
                    filter="url(#glow)"
                  />
                  {n.incoming > 1 && (
                    <ellipse
                      cx={n.x}
                      cy={n.y}
                      rx={n.r * 2.8}
                      ry={n.r * 1.2}
                      transform={`rotate(-25 ${n.x} ${n.y})`}
                      fill="none"
                      stroke={n.color}
                      strokeWidth=".65"
                      opacity=".6"
                    />
                  )}
                  {chosen && (
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={n.r + 11}
                      fill="none"
                      stroke="#f0d29a"
                      strokeDasharray="3 4"
                    />
                  )}
                  <circle cx={n.x} cy={n.y} r={n.r} fill="url(#body)" />
                  {(chosen || hover === n.id || zoom > 1.6) && (
                    <text
                      x={n.x + 13}
                      y={n.y + 4}
                      transform={`rotate(${-rotation} ${n.x + 13} ${n.y + 4})`}
                      fill="#e9e6de"
                      className="body-label"
                    >
                      {n.name}
                    </text>
                  )}
                  {zoom > 1.7 &&
                    data.nodes
                      .filter((s) => s.path === n.path && s.kind !== "file")
                      .slice(0, 15)
                      .map((s, i) => {
                        const a = i * 2.4;
                        return (
                          <circle
                            key={s.id}
                            cx={n.x + Math.cos(a) * (22 + i * 2)}
                            cy={n.y + Math.sin(a) * (22 + i * 2)}
                            r="1.7"
                            fill={n.color}
                          >
                            <title>
                              {s.kind}: {s.name}, lines {s.start}–{s.end}
                            </title>
                          </circle>
                        );
                      })}
                </g>
              );
            })}
        </g>
      </svg>
      {!compact && (
        <>
          <div className="map-corner">
            <span className="eyebrow">STRUCTURAL VIEW</span>
            <span>
              {clusterMode
                ? `${data.files} files · ${regions.length} counted regions`
                : `${shownBodies.length} of ${data.files} file bodies`}
            </span>
            <span className="muted">
              {clusterMode
                ? "Select a region to inspect its files"
                : regionFocus || "Every body is an indexed file"}
            </span>
          </div>
          <div className="map-tools">
            {regionFocus && (
              <button onClick={() => setRegionFocus("")}>All regions</button>
            )}
            <button
              aria-label="Zoom out"
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.2))}
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              aria-label="Zoom in"
              onClick={() => setZoom((z) => Math.min(3, z + 0.2))}
            >
              +
            </button>
            <button
              aria-label="Rotate map"
              onClick={() => setRotation((r) => r + 20)}
            >
              ↻
            </button>
            <button
              onClick={() => {
                setZoom(1);
                setOffset({ x: 0, y: 0 });
                setRotation(-12);
              }}
            >
              Reset
            </button>
          </div>
          <div className="map-caption">
            {picked ? (
              <>
                <strong>{picked.name}</strong>
                <span>
                  {picked.incoming} incoming · {picked.subsystem}
                </span>
              </>
            ) : (
              <>
                <strong>Architecture, brought into focus.</strong>
                <span>Drag to pan · scroll to zoom · select to inspect</span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
