import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  applyEmphasis,
  buildGalaxy,
  categoryColors,
  colorFor,
  defaultFilters,
  hash,
  shift,
  type Body,
  type Category,
  type Filters,
  type Galaxy,
  type GalaxyPayload,
} from "./galaxy-model";

// Instanced body shader. One draw call carries every moon, planet and star;
// per-instance attributes decide the surface, so no two bodies look alike.
const bodyVertex = `
attribute vec3 aTint; attribute float aSeed; attribute float aClass; attribute float aEmph;
varying vec3 vTint; varying float vSeed; varying float vClass; varying float vEmph;
varying vec3 vNormalV; varying vec3 vPos;
void main(){
  vTint = aTint; vSeed = aSeed; vClass = aClass; vEmph = aEmph; vPos = position;
  mat3 im = mat3(instanceMatrix);
  vNormalV = normalize(normalMatrix * normalize(im * normal));
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const bodyFragment = `
precision highp float;
varying vec3 vTint; varying float vSeed; varying float vClass; varying float vEmph;
varying vec3 vNormalV; varying vec3 vPos;
float h(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float n(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p){ return n(p) * 0.55 + n(p * 2.07) * 0.26 + n(p * 4.13) * 0.13 + n(p * 8.7) * 0.06; }
void main(){
  vec3 p = normalize(vPos) * 2.6 + vSeed;
  float f = fbm(p);
  float lat = normalize(vPos).y;
  // Gas-giant banding for some seeds, cratered rock for others.
  float gas = step(0.55, fract(vSeed * 0.37));
  float bands = sin(lat * (7.0 + fract(vSeed * 0.11) * 9.0) + f * 3.4) * 0.5 + 0.5;
  float craters = smoothstep(0.52, 0.78, fbm(p * 2.4 + 11.0));
  float surface = mix(mix(f, craters * 0.75 + f * 0.45, 0.55), mix(bands, f, 0.35), gas);
  vec3 N = normalize(vNormalV);
  vec3 L = normalize(vec3(-0.55, 0.72, 0.85));
  float light = max(dot(N, L), 0.0);
  float wrap = max(dot(N, L) * 0.5 + 0.5, 0.0);
  float rim = pow(1.0 - max(N.z, 0.0), 3.0);
  vec3 shade = vTint * (0.42 + 0.72 * surface);
  vec3 rock = shade * (0.10 + light * 1.12 + wrap * 0.22) + vTint * rim * 0.55;
  // Stars: granulated emissive core with a white-hot centre.
  float gran = fbm(p * 1.7 + 3.0);
  vec3 star = mix(vTint, vec3(1.0, 0.95, 0.82), gran * 0.85) * (1.05 + gran * 0.75);
  star += vec3(1.0, 0.9, 0.72) * pow(max(N.z, 0.0), 2.5) * 0.5;
  vec3 color = mix(rock, star, step(1.5, vClass));
  gl_FragColor = vec4(color * vEmph, 1.0);
}`;
// Additive radial falloff, used for star coronae.
const glowVertex = `
attribute float aScale; attribute vec3 gTint; attribute float gAlpha;
varying vec2 vUv; varying vec3 vTint; varying float vAlpha;
void main(){
  vUv = uv; vTint = gTint; vAlpha = gAlpha;
  vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  center.xy += position.xy * aScale;
  gl_Position = projectionMatrix * center;
}`;
const glowFragment = `
precision mediump float;
varying vec2 vUv; varying vec3 vTint; varying float vAlpha;
void main(){
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - d), 3.2) * vAlpha;
  gl_FragColor = vec4(vTint, a);
}`;
// Debris, nebula haze and background stars: soft round points, cheap at tens of
// thousands.
const dustVertex = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
varying float vAlpha; varying vec3 vColor;
void main(){
  vAlpha = aAlpha; vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (260.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const dustFragment = `
precision mediump float;
varying float vAlpha; varying vec3 vColor;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor, pow(1.0 - d, 2.0) * vAlpha);
}`;
const nebulaFragment = `
precision mediump float;
varying float vAlpha; varying vec3 vColor;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor, pow(1.0 - d, 3.0) * vAlpha);
}`;

type Props = {
  data: GalaxyPayload;
  selected: string;
  onSelect: (path: string) => void;
  relevant: string[];
  search: string;
  filters: Filters;
  onFilters: (next: Filters) => void;
  onGalaxy?: (galaxy: Galaxy) => void;
};
type Api = {
  sync: () => void;
  reset: () => void;
  top: () => void;
  spin: (v: boolean) => void;
  focus: (path: string) => void;
};

export default function RepoGalaxy({
  data,
  selected,
  onSelect,
  relevant,
  search,
  filters,
  onFilters,
  onGalaxy,
}: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const api = useRef<Api>(undefined);
  // Camera survives a rebuild, so changing a filter re-arranges the galaxy
  // under the viewer rather than throwing away where they were looking.
  const view = useRef<{ position: THREE.Vector3; target: THREE.Vector3 }>(
    undefined,
  );
  const [failed, setFailed] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [hover, setHover] = useState<{ body: Body; x: number; y: number }>();
  const galaxy = useMemo(() => buildGalaxy(data, filters), [data, filters]);
  const state = useRef({ selected, onSelect, relevant, search, filters });
  state.current = { selected, onSelect, relevant, search, filters };
  useEffect(() => onGalaxy?.(galaxy), [galaxy, onGalaxy]);
  const counts = useMemo(() => {
    const c = { star: 0, planet: 0, moon: 0, debris: 0 };
    for (const b of galaxy.bodies) c[b.bodyClass]++;
    return c;
  }, [galaxy]);

  useEffect(() => {
    const host: HTMLDivElement | null = mount.current;
    if (!host || failed) return;
    const stage: HTMLDivElement = host;
    let renderer: THREE.WebGLRenderer;
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2", {
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
      if (!context) {
        setFailed(true);
        return;
      }
      renderer = new THREE.WebGLRenderer({
        canvas,
        context,
        antialias: true,
        alpha: false,
      });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setClearColor("#07080b");
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
    const controls = new OrbitControls(camera, renderer.domElement);
    const extent = galaxy.extent;
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 1.2;
    controls.maxDistance = extent * 7;
    controls.autoRotateSpeed = 0.32;
    controls.zoomSpeed = 0.9;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const disposables: { dispose: () => void }[] = [];
    const bodies = galaxy.bodies;
    const solid = bodies.filter((b) => b.bodyClass !== "debris");
    const debris = bodies.filter((b) => b.bodyClass === "debris");
    const stars = solid.filter((b) => b.bodyClass === "star");
    const mode = state.current.filters.colorMode;
    const tintOf = (b: Body) => new THREE.Color(colorFor(b, galaxy, mode));

    const points = (
      count: number,
      fill: (
        i: number,
        set: (
          x: number,
          y: number,
          z: number,
          size: number,
          alpha: number,
          color: number[],
        ) => void,
      ) => void,
      fragment = dustFragment,
    ) => {
      const n = Math.max(1, count);
      const pos = new Float32Array(n * 3),
        size = new Float32Array(n),
        alpha = new Float32Array(n),
        color = new Float32Array(n * 3);
      for (let i = 0; i < count; i++)
        fill(i, (x, y, z, s, a, c) => {
          pos.set([x, y, z], i * 3);
          size[i] = s;
          alpha[i] = a;
          color.set(c, i * 3);
        });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
      g.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
      g.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
      const m = new THREE.ShaderMaterial({
        vertexShader: dustVertex,
        fragmentShader: fragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const object = new THREE.Points(g, m);
      object.frustumCulled = false;
      scene.add(object);
      disposables.push(g, m);
      return { object, geometry: g, alpha, color };
    };

    // --- background starfield -------------------------------------------
    points(2400, (_, set) => {
      const t = Math.random() * Math.PI * 2,
        u = Math.random() * 2 - 1,
        r = extent * (3.4 + Math.random() * 2.8),
        s = Math.sqrt(1 - u * u);
      const w = 0.7 + Math.random() * 0.3;
      // A few distant stars pick up a cool or warm cast, as real fields do.
      const cast = Math.random();
      set(
        Math.cos(t) * s * r,
        u * r * 0.7,
        Math.sin(t) * s * r,
        0.4 + Math.random() * 1.1,
        0.16 + Math.random() * 0.4,
        cast < 0.12
          ? [w, w * 0.86, w * 0.7]
          : cast > 0.9
            ? [w * 0.76, w * 0.86, w]
            : [w, w * 0.97, w * 0.92],
      );
    });

    // --- nebula: the milky band, drawn from the bodies themselves ---------
    // Each file scatters a little gas around itself, tinted like its subsystem
    // and warmed toward the core, so the haze traces the real arms instead of
    // being decorative noise.
    if (bodies.length > 1) {
      // Additive haze from many hues converges on grey, so each cloud is
      // pushed away from its own luminance and kept sparse; the core is left
      // clear so the stars there stay crisp.
      const per = bodies.length > 4000 ? 1 : bodies.length > 1200 ? 3 : 8;
      const saturate = (c: number[], k = 1.85) => {
        const l = (c[0] + c[1] + c[2]) / 3;
        return c.map((v) => Math.max(0, Math.min(1, l + (v - l) * k)));
      };
      points(
        bodies.length * per,
        (i, set) => {
          const b = bodies[Math.floor(i / per)];
          const seed = hash(b.path + i);
          const rnd = (k: number) =>
            (((seed * (k * 2654435761)) >>> 8) % 1000) / 1000;
          const spin = rnd(1) * Math.PI * 2,
            spanR = extent * (0.02 + rnd(2) * 0.08),
            lift = (rnd(3) - 0.5) * extent * 0.05;
          const tint = saturate(shift(b.color, b.depth, 0.5));
          set(
            b.x + Math.cos(spin) * spanR,
            b.y + lift,
            b.z + Math.sin(spin) * spanR,
            16 + rnd(4) * 34,
            // Fades out toward the bright core and the empty rim.
            b.depth < 0.14
              ? 0
              : (0.008 + rnd(5) * 0.016) * (1 - b.depth * 0.45),
            tint,
          );
        },
        nebulaFragment,
      );
    }

    // --- galactic core glow ---------------------------------------------
    {
      const g = new THREE.PlaneGeometry(1, 1);
      const m = new THREE.ShaderMaterial({
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; vec4 c = modelViewMatrix * vec4(0.,0.,0.,1.); c.xy += position.xy * ${(extent * 1.7).toFixed(2)}; gl_Position = projectionMatrix * c; }`,
        fragmentShader: `precision mediump float; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 3.6); gl_FragColor = vec4(mix(vec3(0.72,0.80,1.0), vec3(1.0,0.87,0.62), a), a * 0.20); }`,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const core = new THREE.Mesh(g, m);
      core.renderOrder = -1;
      core.frustumCulled = false;
      scene.add(core);
      disposables.push(g, m);
    }

    // --- solid bodies (moons, planets, stars) ----------------------------
    const sphere = new THREE.SphereGeometry(1, 28, 20);
    disposables.push(sphere);
    const tint = new Float32Array(Math.max(1, solid.length) * 3),
      seed = new Float32Array(Math.max(1, solid.length)),
      cls = new Float32Array(Math.max(1, solid.length)),
      emph = new Float32Array(Math.max(1, solid.length)).fill(1);
    for (let i = 0; i < solid.length; i++) {
      seed[i] = hash(solid[i].path) % 97;
      cls[i] =
        solid[i].bodyClass === "star"
          ? 2
          : solid[i].bodyClass === "planet"
            ? 1
            : 0;
      const c = tintOf(solid[i]);
      tint.set([c.r, c.g, c.b], i * 3);
    }
    sphere.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
    sphere.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    sphere.setAttribute("aClass", new THREE.InstancedBufferAttribute(cls, 1));
    sphere.setAttribute("aEmph", new THREE.InstancedBufferAttribute(emph, 1));
    const bodyMaterial = new THREE.ShaderMaterial({
      vertexShader: bodyVertex,
      fragmentShader: bodyFragment,
    });
    disposables.push(bodyMaterial);
    const solidMesh = new THREE.InstancedMesh(
      sphere,
      bodyMaterial,
      Math.max(1, solid.length),
    );
    solidMesh.frustumCulled = false;
    solidMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(solidMesh);
    const matrix = new THREE.Matrix4(),
      scale = new THREE.Vector3(),
      position = new THREE.Vector3(),
      quaternion = new THREE.Quaternion(),
      projected = new THREE.Vector3();

    // --- star coronae ----------------------------------------------------
    const glowPlane = new THREE.PlaneGeometry(1, 1);
    disposables.push(glowPlane);
    const gScale = new Float32Array(Math.max(1, stars.length)),
      gTint = new Float32Array(Math.max(1, stars.length) * 3),
      gAlpha = new Float32Array(Math.max(1, stars.length)).fill(0.42);
    glowPlane.setAttribute(
      "aScale",
      new THREE.InstancedBufferAttribute(gScale, 1),
    );
    glowPlane.setAttribute(
      "gTint",
      new THREE.InstancedBufferAttribute(gTint, 3),
    );
    glowPlane.setAttribute(
      "gAlpha",
      new THREE.InstancedBufferAttribute(gAlpha, 1),
    );
    const glowMaterial = new THREE.ShaderMaterial({
      vertexShader: glowVertex,
      fragmentShader: glowFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    disposables.push(glowMaterial);
    const glowMesh = new THREE.InstancedMesh(
      glowPlane,
      glowMaterial,
      Math.max(1, stars.length),
    );
    glowMesh.frustumCulled = false;
    glowMesh.renderOrder = 2;
    scene.add(glowMesh);
    for (let i = 0; i < stars.length; i++) {
      const b = stars[i];
      position.set(b.x, b.y, b.z);
      scale.setScalar(1);
      matrix.compose(position, quaternion, scale);
      glowMesh.setMatrixAt(i, matrix);
      gScale[i] = b.radius * 6;
      const c = tintOf(b);
      gTint.set([c.r, c.g, c.b], i * 3);
    }
    glowMesh.instanceMatrix.needsUpdate = true;

    // --- debris field ----------------------------------------------------
    const debrisLayer = points(debris.length, (i, set) => {
      const b = debris[i],
        c = tintOf(b);
      set(
        b.x,
        b.y,
        b.z,
        1.6 + Math.min(1.4, Math.log2(b.bytes + 2) * 0.14),
        0.55,
        [c.r, c.g, c.b],
      );
    });

    // --- relationships ---------------------------------------------------
    const ePos = new Float32Array(Math.max(1, galaxy.edges.length) * 6),
      eColor = new Float32Array(Math.max(1, galaxy.edges.length) * 6);
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(ePos, 3));
    edgeGeometry.setAttribute("color", new THREE.BufferAttribute(eColor, 3));
    for (let i = 0; i < galaxy.edges.length; i++) {
      const a = bodies[galaxy.edges[i].from],
        b = bodies[galaxy.edges[i].to];
      ePos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    }
    const edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    disposables.push(edgeGeometry, edgeMaterial);
    const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    edgeLines.frustumCulled = false;
    scene.add(edgeLines);
    // Arcs for the selected file's own relationships, drawn brightly on top.
    const ARC = 14;
    const aPos = new Float32Array(1024 * ARC * 6);
    const arcGeometry = new THREE.BufferGeometry();
    arcGeometry.setAttribute("position", new THREE.BufferAttribute(aPos, 3));
    const arcMaterial = new THREE.LineBasicMaterial({
      color: "#ffdca3",
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    disposables.push(arcGeometry, arcMaterial);
    const arcs = new THREE.LineSegments(arcGeometry, arcMaterial);
    arcs.frustumCulled = false;
    arcs.renderOrder = 3;
    scene.add(arcs);

    // --- labels ----------------------------------------------------------
    const labelLayer = document.createElement("div");
    labelLayer.className = "galaxy-labels";
    host.appendChild(labelLayer);
    const labels = solid
      .map((b, i) => ({ b, i }))
      .sort((a, b) => b.b.importance - a.b.importance)
      .slice(0, 60)
      .map(({ b }) => {
        const element = document.createElement("span");
        element.textContent = b.name;
        labelLayer.appendChild(element);
        return { element, body: b };
      });

    // Only emphasis and the selection change without a rebuild; positions and
    // the relationship web are fixed for a given filter set.
    function sync() {
      const { search: q, relevant: rel, selected: sel } = state.current;
      const emphasis = applyEmphasis(galaxy, q, rel);
      for (let i = 0; i < solid.length; i++) {
        const b = solid[i],
          chosen = b.path === sel;
        position.set(b.x, b.y, b.z);
        scale.setScalar(b.radius * (chosen ? 1.4 : 1));
        matrix.compose(position, quaternion, scale);
        solidMesh.setMatrixAt(i, matrix);
        emph[i] = chosen ? 1.9 : emphasis[b.index];
      }
      solidMesh.instanceMatrix.needsUpdate = true;
      (sphere.getAttribute("aEmph") as THREE.BufferAttribute).needsUpdate =
        true;
      for (let i = 0; i < stars.length; i++)
        gAlpha[i] = 0.42 * emphasis[stars[i].index];
      (glowPlane.getAttribute("gAlpha") as THREE.BufferAttribute).needsUpdate =
        true;
      for (let i = 0; i < debris.length; i++)
        debrisLayer.alpha[i] = 0.55 * emphasis[debris[i].index];
      (
        debrisLayer.geometry.getAttribute("aAlpha") as THREE.BufferAttribute
      ).needsUpdate = true;
      const only = state.current.filters.links === "selected";
      for (let i = 0; i < galaxy.edges.length; i++) {
        const edge = galaxy.edges[i],
          a = bodies[edge.from],
          b = bodies[edge.to];
        const touches = a.path === sel || b.path === sel;
        const dim =
          (only && !touches
            ? 0
            : sel && !touches
              ? 0.045
              : touches
                ? 0.45
                : 0.1) * Math.min(emphasis[edge.from], emphasis[edge.to]);
        const warm =
          edge.kind === "tests" ? [0.42, 0.62, 0.82] : [0.82, 0.64, 0.36];
        for (const o of [i * 6, i * 6 + 3])
          eColor.set([warm[0] * dim, warm[1] * dim, warm[2] * dim], o);
      }
      (
        edgeGeometry.getAttribute("color") as THREE.BufferAttribute
      ).needsUpdate = true;
      let drawn = 0;
      const chosenBody = sel ? galaxy.byPath.get(sel) : undefined;
      if (chosenBody)
        for (const edge of galaxy.edges) {
          if (edge.from !== chosenBody.index && edge.to !== chosenBody.index)
            continue;
          if (drawn >= 1024) break;
          const from = bodies[edge.from],
            to = bodies[edge.to];
          const curve = new THREE.QuadraticBezierCurve3(
            new THREE.Vector3(from.x, from.y, from.z),
            new THREE.Vector3(
              (from.x + to.x) / 2,
              (from.y + to.y) / 2 +
                Math.hypot(from.x - to.x, from.z - to.z) * 0.22,
              (from.z + to.z) / 2,
            ),
            new THREE.Vector3(to.x, to.y, to.z),
          );
          const pts = curve.getPoints(ARC);
          for (let s = 0; s < ARC; s++) {
            const o = (drawn * ARC + s) * 6;
            aPos.set([pts[s].x, pts[s].y, pts[s].z], o);
            aPos.set([pts[s + 1].x, pts[s + 1].y, pts[s + 1].z], o + 3);
          }
          drawn++;
        }
      arcGeometry.setDrawRange(0, drawn * ARC * 2);
      (
        arcGeometry.getAttribute("position") as THREE.BufferAttribute
      ).needsUpdate = true;
      request();
    }

    // --- interaction ------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: Math.max(0.35, extent * 0.012) };
    const pointer = new THREE.Vector2();
    function pick(e: PointerEvent): Body | undefined {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const solidHit = raycaster.intersectObject(solidMesh, false)[0];
      const dustHit = raycaster.intersectObject(debrisLayer.object, false)[0];
      const best =
        solidHit && dustHit
          ? solidHit.distance <= dustHit.distance
            ? solidHit
            : dustHit
          : (solidHit ?? dustHit);
      if (!best) return undefined;
      return best.object === solidMesh
        ? solid[best.instanceId ?? -1]
        : debris[best.index ?? -1];
    }
    let downAt = { x: 0, y: 0 };
    const pointerDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const pointerUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
      const body = pick(e);
      if (body) state.current.onSelect(body.path);
    };
    const pointerMove = (e: PointerEvent) => {
      if (e.buttons) {
        setHover(undefined);
        return;
      }
      const body = pick(e),
        rect = host.getBoundingClientRect();
      renderer.domElement.style.cursor = body ? "pointer" : "grab";
      setHover(
        body
          ? {
              body,
              x: Math.min(e.clientX - rect.left + 16, rect.width - 260),
              y: Math.min(e.clientY - rect.top + 16, rect.height - 96),
            }
          : undefined,
      );
    };
    const pointerLeave = () => setHover(undefined);

    const taken = new Set<string>();
    let frame = 0,
      onScreen = true,
      disposed = false;
    function request() {
      if (!frame && onScreen) frame = requestAnimationFrame(render);
    }
    function render() {
      frame = 0;
      if (disposed || !onScreen) return;
      const moving = controls.update();
      view.current = {
        position: camera.position.clone(),
        target: controls.target.clone(),
      };
      // Labels are drawn most-important first and skipped when they would land
      // on a cell another label already claimed, so the core stops piling up.
      taken.clear();
      for (const label of labels) {
        const b = label.body;
        projected.set(b.x, b.y + b.radius + 0.9, b.z).project(camera);
        const chosen = b.path === state.current.selected;
        const near = camera.position.distanceTo(controls.target) < extent * 0.9;
        const onscreen =
          Math.abs(projected.x) < 0.97 &&
          Math.abs(projected.y) < 0.96 &&
          projected.z < 1;
        const sx = (projected.x * 0.5 + 0.5) * stage.clientWidth,
          sy = (-projected.y * 0.5 + 0.5) * stage.clientHeight;
        const cell = `${Math.round(sx / 96)}:${Math.round(sy / 18)}`;
        const free = chosen || !taken.has(cell);
        const show =
          onscreen && free && (chosen || b.bodyClass === "star" || near);
        if (show) taken.add(cell);
        label.element.style.display = show ? "block" : "none";
        if (show)
          label.element.style.transform = `translate(${sx}px,${sy}px) translate(-50%,-100%)`;
        label.element.classList.toggle("is-selected", chosen);
      }
      renderer.render(scene, camera);
      if (controls.autoRotate || moving) request();
    }
    const reset = () => {
      controls.target.set(0, 0, 0);
      camera.position.set(extent * 0.3, extent * 1.0, extent * 1.65);
      controls.update();
      request();
    };
    const resizer = new ResizeObserver(() => {
      renderer.setSize(stage.clientWidth, stage.clientHeight);
      camera.aspect = Math.max(0.1, stage.clientWidth / stage.clientHeight);
      camera.updateProjectionMatrix();
      request();
    });
    resizer.observe(host);
    const visibility = () => {
      onScreen = !document.hidden;
      if (onScreen) request();
    };
    document.addEventListener("visibilitychange", visibility);
    const keyboard = (e: KeyboardEvent) => {
      const keys = [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "+",
        "-",
        "Home",
      ];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      controls.autoRotate = false;
      setSpinning(false);
      if (e.key === "Home") return reset();
      const offset = camera.position.clone().sub(controls.target),
        s = new THREE.Spherical().setFromVector3(offset);
      if (e.key === "ArrowLeft") s.theta -= 0.12;
      if (e.key === "ArrowRight") s.theta += 0.12;
      if (e.key === "ArrowUp") s.phi = Math.max(0.05, s.phi - 0.12);
      if (e.key === "ArrowDown") s.phi = Math.min(Math.PI - 0.05, s.phi + 0.12);
      if (e.key === "+") s.radius = Math.max(1.2, s.radius * 0.85);
      if (e.key === "-") s.radius = Math.min(extent * 7, s.radius / 0.85);
      camera.position.copy(
        new THREE.Vector3().setFromSpherical(s).add(controls.target),
      );
      controls.update();
      request();
    };
    host.addEventListener("keydown", keyboard);
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerleave", pointerLeave);
    controls.addEventListener("change", request);
    const lost = (e: Event) => {
      e.preventDefault();
      setFailed(true);
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);

    api.current = {
      sync,
      reset,
      top: () => {
        camera.position.set(0.01, extent * 2.5, 0.01);
        controls.target.set(0, 0, 0);
        controls.update();
        request();
      },
      spin: (v) => {
        controls.autoRotate = v && !reduce.matches;
        request();
      },
      focus: (path) => {
        const b = galaxy.byPath.get(path);
        if (!b) return;
        const target = new THREE.Vector3(b.x, b.y, b.z);
        // Pan to the body, keeping the viewer's own zoom level unless they are
        // so far out that the body would be invisible.
        const distance = Math.min(
          camera.position.distanceTo(controls.target),
          extent * 1.9,
        );
        const offset = camera.position
          .clone()
          .sub(controls.target)
          .normalize()
          .multiplyScalar(Math.max(extent * 0.35, distance));
        controls.target.copy(target);
        camera.position.copy(target.clone().add(offset));
        controls.update();
        request();
      },
    };
    sync();
    if (view.current) {
      camera.position.copy(view.current.position);
      controls.target.copy(view.current.target);
      controls.update();
      request();
    } else reset();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizer.disconnect();
      controls.dispose();
      document.removeEventListener("visibilitychange", visibility);
      host.removeEventListener("keydown", keyboard);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerleave", pointerLeave);
      for (const d of disposables) d.dispose();
      solidMesh.dispose();
      glowMesh.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelLayer.remove();
      api.current = undefined;
    };
  }, [galaxy, failed]);

  useEffect(() => {
    api.current?.sync();
  }, [selected, search, relevant]);
  // Only pan for selections the viewer makes; the page opens on the whole map.
  const firstSelection = useRef(true);
  useEffect(() => {
    if (firstSelection.current) {
      firstSelection.current = false;
      return;
    }
    if (selected) api.current?.focus(selected);
  }, [selected]);

  if (failed)
    return (
      <div className="galaxy-fallback" role="status">
        <h3>3D rendering is unavailable on this device</h3>
        <p>
          Switch to <b>Components</b> above for the same repository as a
          sortable list, with every relationship count intact.
        </p>
      </div>
    );
  return (
    <div className="galaxy-stage">
      <div
        ref={mount}
        className="galaxy-canvas"
        tabIndex={0}
        role="group"
        aria-label={`Repository galaxy. ${galaxy.bodies.length} of ${galaxy.total} files shown. Drag to orbit, scroll to approach, arrow keys rotate, plus and minus zoom, Home resets. Use the Components view for a list.`}
      />
      <GalaxyFilters
        galaxy={galaxy}
        filters={filters}
        onFilters={onFilters}
        counts={counts}
      />
      <div className="galaxy-controls">
        <span>Drag to orbit · scroll to approach</span>
        <div>
          <button onClick={() => api.current?.top()}>Top view</button>
          <button
            aria-pressed={spinning}
            onClick={() => {
              const v = !spinning;
              setSpinning(v);
              api.current?.spin(v);
            }}
          >
            {spinning ? "Pause" : "Spin"}
          </button>
          <button onClick={() => api.current?.reset()}>Reset</button>
        </div>
      </div>
      {hover && (
        <div className="galaxy-tooltip" style={{ left: hover.x, top: hover.y }}>
          <strong>{hover.body.name}</strong>
          <code>{hover.body.path}</code>
          <small>
            {hover.body.bodyClass} · {hover.body.incoming} in ·{" "}
            {hover.body.outgoing} out
          </small>
        </div>
      )}
    </div>
  );
}

function GalaxyFilters({
  galaxy,
  filters,
  onFilters,
  counts,
}: {
  galaxy: Galaxy;
  filters: Filters;
  onFilters: (next: Filters) => void;
  counts: Record<string, number>;
}) {
  const [open, setOpen] = useState(true);
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });
  const toggle = <T extends string>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  const dirty =
    filters.regions.length > 0 ||
    filters.categories.length > 0 ||
    filters.minIncoming > 0 ||
    filters.edgeKinds.length > 0 ||
    filters.links !== "all" ||
    !!filters.focus;
  return (
    <div className={`galaxy-filters${open ? "" : " collapsed"}`}>
      <button className="filters-head" onClick={() => setOpen(!open)}>
        <span>Filters</span>
        <small>
          {galaxy.bodies.length.toLocaleString()} /{" "}
          {galaxy.total.toLocaleString()} files
        </small>
        <i>{open ? "−" : "+"}</i>
      </button>
      {open && (
        <div className="filters-body">
          {filters.focus && (
            <section>
              <h5>Focus</h5>
              <div className="focus-row">
                <code>{filters.focus}</code>
                <button onClick={() => set({ focus: "" })}>Clear</button>
              </div>
              <label className="slider">
                <span>
                  Within <b>{filters.depth}</b>{" "}
                  {filters.depth === 1 ? "hop" : "hops"}
                </span>
                <input
                  type="range"
                  min={1}
                  max={5}
                  value={filters.depth}
                  onChange={(e) => set({ depth: Number(e.target.value) })}
                />
              </label>
            </section>
          )}
          <section>
            <h5>Components</h5>
            <label className="slider">
              <span>
                At least <b>{filters.minIncoming}</b> incoming
                {filters.minIncoming > 0 && " — debris hidden"}
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(1, Math.min(20, galaxy.maxIncoming))}
                value={filters.minIncoming}
                onChange={(e) => set({ minIncoming: Number(e.target.value) })}
              />
            </label>
            <div className="chips">
              {galaxy.regions.slice(0, 16).map((r) => (
                <button
                  key={r.name}
                  className={
                    filters.regions.includes(r.name) ? "chip on" : "chip"
                  }
                  onClick={() =>
                    set({ regions: toggle(filters.regions, r.name) })
                  }
                >
                  <i style={{ background: r.color }} />
                  {r.name}
                  <em>{r.count}</em>
                </button>
              ))}
            </div>
            <div className="chips">
              {galaxy.categories.map((c) => (
                <button
                  key={c.name}
                  className={
                    filters.categories.includes(c.name) ? "chip on" : "chip"
                  }
                  onClick={() =>
                    set({
                      categories: toggle(
                        filters.categories,
                        c.name as Category,
                      ),
                    })
                  }
                >
                  <i style={{ background: categoryColors[c.name] }} />
                  {c.name}
                  <em>{c.count}</em>
                </button>
              ))}
            </div>
          </section>
          <section>
            <h5>Relationships</h5>
            <div className="segmented small">
              {(
                [
                  ["all", "All"],
                  ["selected", "Selected"],
                  ["none", "Hidden"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={filters.links === value ? "selected" : ""}
                  onClick={() => set({ links: value })}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="chips">
              {galaxy.kinds.map((k) => (
                <button
                  key={k}
                  className={filters.edgeKinds.includes(k) ? "chip on" : "chip"}
                  disabled={filters.links === "none"}
                  onClick={() =>
                    set({ edgeKinds: toggle(filters.edgeKinds, k) })
                  }
                >
                  <i
                    style={{
                      background: k === "tests" ? "#6b9ed1" : "#d1a35c",
                    }}
                  />
                  {k}
                </button>
              ))}
            </div>
            <p className="filters-note">
              {galaxy.edges.length.toLocaleString()} relationships between the
              files on screen.
            </p>
          </section>
          <section>
            <h5>Colour by</h5>
            <div className="segmented small">
              {(["region", "category", "importance"] as const).map((mode) => (
                <button
                  key={mode}
                  className={filters.colorMode === mode ? "selected" : ""}
                  onClick={() => set({ colorMode: mode })}
                >
                  {mode === "region"
                    ? "Subsystem"
                    : mode === "category"
                      ? "Type"
                      : "Importance"}
                </button>
              ))}
            </div>
          </section>
          <section className="filters-key">
            <h5>Body type</h5>
            <ul>
              <li>
                <i className="dot star" /> Star · {galaxy.cuts.star}+ incoming
                <em>{counts.star}</em>
              </li>
              <li>
                <i className="dot planet" /> Planet · {galaxy.cuts.planet}+
                incoming
                <em>{counts.planet}</em>
              </li>
              <li>
                <i className="dot moon" /> Moon · linked at least once
                <em>{counts.moon}</em>
              </li>
              <li>
                <i className="dot debris" /> Debris · no resolved links
                <em>{counts.debris}</em>
              </li>
            </ul>
            <p className="filters-note">
              Body type comes from links across the whole repository. Distance
              from the core ranks the files currently on screen, so filtering
              re-arranges the galaxy.
            </p>
          </section>
          {dirty && (
            <button
              className="filters-reset"
              onClick={() =>
                onFilters({ ...defaultFilters, colorMode: filters.colorMode })
              }
            >
              Reset filters — showing {galaxy.bodies.length.toLocaleString()} of{" "}
              {galaxy.total.toLocaleString()} files
            </button>
          )}
        </div>
      )}
    </div>
  );
}
