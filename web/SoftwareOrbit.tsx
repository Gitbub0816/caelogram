import { useEffect, useRef, useState } from "react";
import type { MapData } from "./Galaxy";
import { orbitLayout, hash, type Body } from "./orbit-layout";
/** Perspective projection fallback for devices without WebGL. Same topology, never a static illustration. */
export default function SoftwareOrbit({
  data,
  selected,
  onSelect,
  relevant,
  search = "",
}: {
  data: MapData;
  selected: string;
  onSelect: (id: string) => void;
  relevant: string[];
  search?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null),
    latest = useRef({ selected, onSelect, relevant, search });
  latest.current = { selected, onSelect, relevant, search };
  const api = useRef<
    | {
        draw: () => void;
        reset: () => void;
        top: () => void;
        spin: (v: boolean) => void;
      }
    | undefined
  >(undefined);
  const [page, setPage] = useState(0);
  const [region, setRegion] = useState<string>(),
    [spin, setSpin] = useState(false),
    [hover, setHover] = useState<string>();
  const { bodies, aggregated, total, pages } = orbitLayout(data, region, page);
  useEffect(() => {
    const canvas = ref.current!,
      ctx = canvas.getContext("2d")!;
    const layout = orbitLayout(data, region, page),
      bodies = layout.bodies;
    const extent = Math.max(
      8,
      ...bodies.map((b) => Math.hypot(b.x, b.z) + b.radius * 3),
    );
    let theta = 0.4,
      tilt = 0.62,
      zoom = 1.12,
      panX = 0,
      panY = 0,
      spinning = false,
      frame = 0,
      width = 0,
      height = 0,
      visible = true;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    type Projected = {
      body: Body;
      x: number;
      y: number;
      depth: number;
      r: number;
    };
    let projected: Projected[] = [];
    const textures = new Map<string, HTMLCanvasElement>();
    for (const b of bodies) {
      const tex = document.createElement("canvas");
      tex.width = 192;
      tex.height = 192;
      const c = tex.getContext("2d")!;
      c.save();
      c.beginPath();
      c.arc(96, 96, 94, 0, Math.PI * 2);
      c.clip();
      c.fillStyle = b.color;
      c.fillRect(0, 0, 192, 192);
      let seed = hash(b.id);
      const rand = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      for (let i = 0; i < 3000; i++) {
        c.fillStyle = `rgba(${rand() > 0.5 ? "255,233,200" : "31,25,22"},${rand() * 0.18})`;
        c.fillRect(rand() * 192, rand() * 192, 1 + rand() * 4, 1 + rand() * 3);
      }
      if (/config|database|schema/.test(b.region))
        for (let y = 0; y < 192; y += 3 + rand() * 7) {
          c.fillStyle = `rgba(55,36,24,${rand() * 0.35})`;
          c.beginPath();
          c.ellipse(96, y, 112, 3 + rand() * 5, -0.15, 0, Math.PI * 2);
          c.fill();
        }
      const g = c.createRadialGradient(57, 45, 5, 92, 94, 110);
      g.addColorStop(0, "#fff4d13d");
      g.addColorStop(0.4, "#00000000");
      g.addColorStop(0.82, "#00000066");
      g.addColorStop(1, "#050707f5");
      c.fillStyle = g;
      c.fillRect(0, 0, 192, 192);
      c.restore();
      textures.set(b.id, tex);
    }
    function project(x: number, y: number, z: number) {
      const rx = x * Math.cos(theta) - z * Math.sin(theta),
        rz = x * Math.sin(theta) + z * Math.cos(theta),
        ry = y * Math.cos(tilt) - rz * Math.sin(tilt),
        depth = y * Math.sin(tilt) + rz * Math.cos(tilt);
      const perspective = (extent * 3) / (extent * 3 + depth),
        scale = (Math.min(width, height) / (extent * 2.5)) * zoom * perspective;
      return {
        x: width / 2 + rx * scale + panX,
        y: height * 0.49 + ry * scale + panY,
        depth,
        scale,
      };
    }
    function draw() {
      frame = 0;
      if (!visible) return;
      if (spinning && !reduce.matches) theta += 0.002;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#111213";
      ctx.fillRect(0, 0, width, height);
      projected = bodies
        .map((body) => {
          const p = project(body.x, body.y, body.z);
          return { body, ...p, r: Math.max(2.5, body.radius * p.scale) };
        })
        .sort((a, b) => b.depth - a.depth);
      const byId = new Map(projected.map((p) => [p.body.id, p])),
        focus = latest.current,
        related = new Set(focus.relevant),
        query = focus.search.toLowerCase();
      for (const edge of data.edges) {
        if (edge.kind === "contains") continue;
        const a = byId.get(edge.from),
          b = byId.get(edge.to);
        if (!a || !b) continue;
        const active =
          edge.from === focus.selected || edge.to === focus.selected;
        ctx.strokeStyle = active ? "#d8bc8688" : "#b49a7030";
        ctx.lineWidth = active ? 1.2 : 0.65;
        ctx.setLineDash(edge.kind === "tests" ? [3, 4] : []);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(
          (a.x + b.x) / 2,
          (a.y + b.y) / 2 - Math.hypot(a.x - b.x, a.y - b.y) * 0.12,
          b.x,
          b.y,
        );
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const p of projected) {
        const b = p.body,
          chosen = b.id === focus.selected,
          match =
            !query || `${b.name} ${b.region}`.toLowerCase().includes(query);
        ctx.globalAlpha =
          (!match || (related.size && !related.has(b.id))) && !chosen ? 0.3 : 1;
        if (b.incoming >= 3 && !layout.aggregated) {
          const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 5);
          glow.addColorStop(0, b.color + "cc");
          glow.addColorStop(0.2, b.color + "65");
          glow.addColorStop(1, b.color + "00");
          ctx.fillStyle = glow;
          ctx.fillRect(p.x - p.r * 5, p.y - p.r * 5, p.r * 10, p.r * 10);
        }
        ctx.drawImage(
          textures.get(b.id)!,
          p.x - p.r,
          p.y - p.r,
          p.r * 2,
          p.r * 2,
        );
        if (b.incoming >= 2) {
          ctx.strokeStyle = b.color + "77";
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.ellipse(
            p.x,
            p.y,
            p.r * 1.8,
            p.r * Math.max(0.18, Math.sin(tilt)) * 0.85,
            -0.2,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        }
        if (chosen) {
          ctx.strokeStyle = "#ead3a1";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r + 5, 0, Math.PI * 2);
          ctx.stroke();
        }
        const show =
          layout.aggregated ||
          chosen ||
          related.has(b.id) ||
          (query && match) ||
          zoom > 1.6;
        if (show) {
          ctx.font = "11px 'DM Sans', sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = chosen ? "#f1d59b" : "#c3baaa";
          ctx.shadowColor = "#111213";
          ctx.shadowBlur = 6;
          ctx.fillText(
            layout.aggregated ? `${b.region} · ${b.count}` : b.name,
            p.x,
            p.y - p.r - 12,
          );
          ctx.shadowBlur = 0;
        }
      }
      ctx.globalAlpha = 1;
      if (spinning && !reduce.matches) request();
    }
    function request() {
      if (!frame && visible) frame = requestAnimationFrame(draw);
    }
    function reset() {
      theta = 0.4;
      tilt = 0.62;
      zoom = 1.12;
      panX = 0;
      panY = 0;
      request();
    }
    const pointers = new Map<number, { x: number; y: number }>();
    let down = { x: 0, y: 0 },
      distance = 0,
      moved = false;
    const start = (e: PointerEvent) => {
      canvas.focus();
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = { x: e.clientX, y: e.clientY };
      moved = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        distance = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const hit = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return [...projected]
        .reverse()
        .find(
          (p) =>
            Math.hypot(
              p.x - (e.clientX - rect.left),
              p.y - (e.clientY - rect.top),
            ) <
            p.r + 7,
        );
    };
    const move = (e: PointerEvent) => {
      const prior = pointers.get(e.pointerId);
      if (!prior) {
        const b = hit(e)?.body;
        setHover(b ? `${b.name} · ${b.incoming} incoming links` : undefined);
        return;
      }
      const dx = e.clientX - prior.x,
        dy = e.clientY - prior.y;
      moved ||= Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()],
          next = Math.hypot(a.x - b.x, a.y - b.y);
        zoom = Math.max(
          0.35,
          Math.min(5, (zoom * next) / Math.max(1, distance)),
        );
        distance = next;
        panX += dx / 2;
        panY += dy / 2;
      } else if (e.shiftKey || e.buttons === 2) {
        panX += dx;
        panY += dy;
      } else {
        theta += dx * 0.008;
        tilt = Math.max(-1.4, Math.min(1.55, tilt + dy * 0.006));
      }
      request();
    };
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (!moved) {
        const b = hit(e)?.body;
        if (b) {
          if (layout.aggregated) {
            setRegion(b.region);
            setPage(0);
            setSpin(false);
          } else latest.current.onSelect(b.id);
        }
      }
    };
    const cancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
    };
    const menu = (e: Event) => e.preventDefault();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom = Math.max(0.35, Math.min(5, zoom * Math.exp(-e.deltaY * 0.001)));
      request();
    };
    const key = (e: KeyboardEvent) => {
      if (
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "+",
          "-",
          "Home",
        ].includes(e.key)
      )
        return;
      e.preventDefault();
      if (e.key === "Home") reset();
      else if (e.key === "+") zoom = Math.min(5, zoom * 1.2);
      else if (e.key === "-") zoom = Math.max(0.35, zoom / 1.2);
      else if (e.shiftKey) {
        panX += e.key === "ArrowLeft" ? -20 : e.key === "ArrowRight" ? 20 : 0;
        panY += e.key === "ArrowUp" ? -20 : e.key === "ArrowDown" ? 20 : 0;
      } else {
        theta +=
          e.key === "ArrowLeft" ? -0.12 : e.key === "ArrowRight" ? 0.12 : 0;
        tilt = Math.max(
          -1.4,
          Math.min(
            1.55,
            tilt +
              (e.key === "ArrowUp" ? 0.12 : e.key === "ArrowDown" ? -0.12 : 0),
          ),
        );
      }
      request();
    };
    const resize = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect(),
        dpr = Math.min(devicePixelRatio, 1.5);
      width = rect.width;
      height = rect.height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      request();
    });
    resize.observe(canvas);
    const visibility = () => {
      visible = !document.hidden;
      if (visible) request();
    };
    const motion = () => {
      if (reduce.matches) {
        spinning = false;
        setSpin(false);
      }
      request();
    };
    document.addEventListener("visibilitychange", visibility);
    reduce.addEventListener("change", motion);
    canvas.addEventListener("pointerdown", start);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);
    canvas.addEventListener("contextmenu", menu);
    api.current = {
      draw: request,
      reset,
      top: () => {
        tilt = Math.PI / 2;
        request();
      },
      spin: (v) => {
        spinning = v && !reduce.matches;
        if (reduce.matches) setSpin(false);
        request();
      },
    };
    request();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      reduce.removeEventListener("change", motion);
      canvas.removeEventListener("pointerdown", start);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", end);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("contextmenu", menu);
      api.current = undefined;
    };
  }, [data, region, page]);
  useEffect(() => api.current?.draw(), [selected, relevant, search]);
  return (
    <div className="orbital-view">
      <div className="orbital-caption">
        <span>{region || "Repository orbit"}</span>
        <small>
          {aggregated
            ? `${bodies.length} regions · ${data.files} files`
            : `${bodies.length} of ${total} file bodies`}{" "}
          · software renderer
        </small>
      </div>
      {pages > 1 && (
        <div className="orbital-paging">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>
            Page {page + 1} / {pages}
          </span>
          <button
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
      {region && (
        <button
          className="orbital-back"
          onClick={() => {
            setRegion(undefined);
            setPage(0);
          }}
        >
          All regions
        </button>
      )}
      <canvas
        ref={ref}
        className="software-canvas"
        tabIndex={0}
        role="group"
        aria-label="3D repository map. Drag or use arrow keys to rotate, plus and minus to zoom, Shift arrows to pan, Home to reset. Use Components to select with keyboard."
      />
      <div className="orbital-controls">
        <span>{hover || "Drag to orbit · Scroll to approach"}</span>
        <div>
          <button onClick={() => api.current?.top()}>Top view</button>
          <button
            aria-pressed={spin}
            onClick={() => {
              setSpin(!spin);
              api.current?.spin(!spin);
            }}
          >
            {spin ? "Pause spin" : "Spin"}
          </button>
          <button onClick={() => api.current?.reset()}>Reset</button>
        </div>
      </div>
    </div>
  );
}
