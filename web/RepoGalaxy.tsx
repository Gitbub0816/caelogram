import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  applyFilters,
  buildGalaxy,
  categoryColors,
  colorFor,
  defaultFilters,
  hash,
  type Body,
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
// Additive radial falloff, used for star coronae and the galactic core.
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
// Debris and background stars: soft round points, cheap at tens of thousands.
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
  const [failed, setFailed] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [hover, setHover] = useState<{
    body: Body;
    x: number;
    y: number;
  }>();
  const galaxy = useMemo(() => buildGalaxy(data), [data]);
  const state = useRef({
    selected,
    onSelect,
    relevant,
    search,
    filters,
    galaxy,
  });
  state.current = { selected, onSelect, relevant, search, filters, galaxy };
  useEffect(() => onGalaxy?.(galaxy), [galaxy, onGalaxy]);
  const shown = useMemo(
    () => applyFilters(galaxy, filters, search, relevant),
    [galaxy, filters, search, relevant],
  );
  const visibleCount = useMemo(
    () => shown.visible.reduce((a, v) => a + v, 0),
    [shown],
  );

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
    renderer.setClearColor("#08090c");
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2("#08090c", 0.0065);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    const controls = new OrbitControls(camera, renderer.domElement);
    const extent = galaxy.extent;
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 1.5;
    controls.maxDistance = extent * 6;
    controls.autoRotateSpeed = 0.32;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const disposables: { dispose: () => void }[] = [];
    const bodies = galaxy.bodies;
    const solid = bodies.filter((b) => b.bodyClass !== "debris");
    const debris = bodies.filter((b) => b.bodyClass === "debris");
    const stars = solid.filter((b) => b.bodyClass === "star");

    // --- background starfield -------------------------------------------
    {
      const count = 2200,
        pos = new Float32Array(count * 3),
        size = new Float32Array(count),
        alpha = new Float32Array(count),
        color = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const t = Math.random() * Math.PI * 2,
          u = Math.random() * 2 - 1,
          r = extent * (3.2 + Math.random() * 2.6),
          s = Math.sqrt(1 - u * u);
        pos.set([Math.cos(t) * s * r, u * r * 0.7, Math.sin(t) * s * r], i * 3);
        size[i] = 0.4 + Math.random() * 1.1;
        alpha[i] = 0.18 + Math.random() * 0.42;
        const w = 0.72 + Math.random() * 0.28;
        color.set([w, w * 0.97, w * 0.9], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
      g.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
      g.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
      const m = new THREE.ShaderMaterial({
        vertexShader: dustVertex,
        fragmentShader: dustFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const points = new THREE.Points(g, m);
      points.frustumCulled = false;
      scene.add(points);
      disposables.push(g, m);
    }

    // --- galactic core glow ---------------------------------------------
    {
      const g = new THREE.PlaneGeometry(1, 1);
      const m = new THREE.ShaderMaterial({
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; vec4 c = modelViewMatrix * vec4(0.,0.,0.,1.); c.xy += position.xy * ${(extent * 1.7).toFixed(2)}; gl_Position = projectionMatrix * c; }`,
        fragmentShader: `precision mediump float; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - d), 3.6) * 0.16; gl_FragColor = vec4(0.98, 0.86, 0.62, a); }`,
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
    const tint = new Float32Array(solid.length * 3),
      seed = new Float32Array(solid.length),
      cls = new Float32Array(solid.length),
      emph = new Float32Array(solid.length);
    for (let i = 0; i < solid.length; i++) {
      seed[i] = hash(solid[i].path) % 97;
      cls[i] =
        solid[i].bodyClass === "star"
          ? 2
          : solid[i].bodyClass === "planet"
            ? 1
            : 0;
      emph[i] = 1;
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

    // --- star coronae ----------------------------------------------------
    const glowPlane = new THREE.PlaneGeometry(1, 1);
    disposables.push(glowPlane);
    const gScale = new Float32Array(Math.max(1, stars.length)),
      gTint = new Float32Array(Math.max(1, stars.length) * 3),
      gAlpha = new Float32Array(Math.max(1, stars.length));
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

    // --- debris field ----------------------------------------------------
    const debrisGeometry = new THREE.BufferGeometry();
    const dPos = new Float32Array(Math.max(1, debris.length) * 3),
      dSize = new Float32Array(Math.max(1, debris.length)),
      dAlpha = new Float32Array(Math.max(1, debris.length)),
      dColor = new Float32Array(Math.max(1, debris.length) * 3);
    for (let i = 0; i < debris.length; i++) {
      dPos.set([debris[i].x, debris[i].y, debris[i].z], i * 3);
      dSize[i] = 1.5 + Math.min(1.4, Math.log2(debris[i].bytes + 2) * 0.14);
    }
    debrisGeometry.setAttribute("position", new THREE.BufferAttribute(dPos, 3));
    debrisGeometry.setAttribute("aSize", new THREE.BufferAttribute(dSize, 1));
    debrisGeometry.setAttribute("aAlpha", new THREE.BufferAttribute(dAlpha, 1));
    debrisGeometry.setAttribute("aColor", new THREE.BufferAttribute(dColor, 3));
    const debrisMaterial = new THREE.ShaderMaterial({
      vertexShader: dustVertex,
      fragmentShader: dustFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    disposables.push(debrisGeometry, debrisMaterial);
    const debrisPoints = new THREE.Points(debrisGeometry, debrisMaterial);
    debrisPoints.frustumCulled = false;
    scene.add(debrisPoints);

    // --- relationships ---------------------------------------------------
    const edgeGeometry = new THREE.BufferGeometry();
    const ePos = new Float32Array(galaxy.edges.length * 6),
      eColor = new Float32Array(galaxy.edges.length * 6);
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(ePos, 3));
    edgeGeometry.setAttribute("color", new THREE.BufferAttribute(eColor, 3));
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
    const arcGeometry = new THREE.BufferGeometry();
    const ARC = 14;
    const aPos = new Float32Array(1024 * ARC * 6);
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
      .map(({ b, i }) => {
        const element = document.createElement("span");
        element.textContent = b.name;
        labelLayer.appendChild(element);
        return { element, body: b, instance: i };
      });

    const matrix = new THREE.Matrix4(),
      scale = new THREE.Vector3(),
      position = new THREE.Vector3(),
      quaternion = new THREE.Quaternion(),
      projected = new THREE.Vector3();
    const solidIndex = new Map(solid.map((b, i) => [b.path, i] as const));

    let cachedVisibility = applyFilters(
      galaxy,
      state.current.filters,
      state.current.search,
      state.current.relevant,
    );
    const latestVisibility = () => cachedVisibility;
    // Rebuilds every buffer that depends on filters, colouring or selection.
    function sync() {
      const {
        filters: f,
        search: q,
        relevant: rel,
        selected: sel,
      } = state.current;
      cachedVisibility = applyFilters(galaxy, f, q, rel);
      const { visible, emphasis } = cachedVisibility;
      const kinds = new Set(f.edgeKinds);
      for (let i = 0; i < solid.length; i++) {
        const b = solid[i];
        const on = visible[b.index] === 1;
        const chosen = b.path === sel;
        position.set(b.x, b.y, b.z);
        scale.setScalar(on ? b.radius * (chosen ? 1.35 : 1) : 0);
        matrix.compose(position, quaternion, scale);
        solidMesh.setMatrixAt(i, matrix);
        const c = new THREE.Color(colorFor(b, galaxy, f.colorMode));
        tint.set([c.r, c.g, c.b], i * 3);
        emph[i] = chosen ? 1.9 : emphasis[b.index];
      }
      solidMesh.instanceMatrix.needsUpdate = true;
      (sphere.getAttribute("aTint") as THREE.BufferAttribute).needsUpdate =
        true;
      (sphere.getAttribute("aEmph") as THREE.BufferAttribute).needsUpdate =
        true;
      for (let i = 0; i < stars.length; i++) {
        const b = stars[i];
        const on = visible[b.index] === 1;
        position.set(b.x, b.y, b.z);
        scale.setScalar(1);
        matrix.compose(position, quaternion, scale);
        glowMesh.setMatrixAt(i, matrix);
        gScale[i] = b.radius * 6.0;
        const c = new THREE.Color(colorFor(b, galaxy, f.colorMode));
        gTint.set([c.r, c.g, c.b], i * 3);
        gAlpha[i] = on ? 0.42 * emphasis[b.index] : 0;
      }
      glowMesh.instanceMatrix.needsUpdate = true;
      (glowPlane.getAttribute("aScale") as THREE.BufferAttribute).needsUpdate =
        true;
      (glowPlane.getAttribute("gTint") as THREE.BufferAttribute).needsUpdate =
        true;
      (glowPlane.getAttribute("gAlpha") as THREE.BufferAttribute).needsUpdate =
        true;
      for (let i = 0; i < debris.length; i++) {
        const b = debris[i];
        const on = visible[b.index] === 1;
        const c = new THREE.Color(colorFor(b, galaxy, f.colorMode));
        dColor.set([c.r, c.g, c.b], i * 3);
        dAlpha[i] = on ? 0.5 * emphasis[b.index] : 0;
      }
      (
        debrisGeometry.getAttribute("aAlpha") as THREE.BufferAttribute
      ).needsUpdate = true;
      (
        debrisGeometry.getAttribute("aColor") as THREE.BufferAttribute
      ).needsUpdate = true;
      // Base relationship web: only links whose endpoints both survive.
      let e = 0;
      for (const edge of galaxy.edges) {
        if (kinds.size && !kinds.has(edge.kind)) continue;
        if (!visible[edge.from] || !visible[edge.to]) continue;
        const a = bodies[edge.from],
          b = bodies[edge.to];
        ePos.set([a.x, a.y, a.z, b.x, b.y, b.z], e * 6);
        const dim =
          (sel && a.path !== sel && b.path !== sel ? 0.04 : 0.45) *
          Math.min(emphasis[edge.from], emphasis[edge.to]);
        const warm =
          edge.kind === "tests" ? [0.42, 0.6, 0.78] : [0.78, 0.62, 0.36];
        eColor.set(
          [
            warm[0] * dim,
            warm[1] * dim,
            warm[2] * dim,
            warm[0] * dim,
            warm[1] * dim,
            warm[2] * dim,
          ],
          e * 6,
        );
        e++;
      }
      edgeGeometry.setDrawRange(0, e * 2);
      (
        edgeGeometry.getAttribute("position") as THREE.BufferAttribute
      ).needsUpdate = true;
      (
        edgeGeometry.getAttribute("color") as THREE.BufferAttribute
      ).needsUpdate = true;
      // Bright arcs from the selection to everything it touches.
      let a = 0;
      const chosenBody = sel ? galaxy.byPath.get(sel) : undefined;
      if (chosenBody)
        for (const edge of galaxy.edges) {
          if (edge.from !== chosenBody.index && edge.to !== chosenBody.index)
            continue;
          if (kinds.size && !kinds.has(edge.kind)) continue;
          if (!visible[edge.from] || !visible[edge.to]) continue;
          if (a >= 1024) break;
          const from = bodies[edge.from],
            to = bodies[edge.to];
          const mid = new THREE.Vector3(
            (from.x + to.x) / 2,
            (from.y + to.y) / 2 +
              Math.hypot(from.x - to.x, from.z - to.z) * 0.22,
            (from.z + to.z) / 2,
          );
          const curve = new THREE.QuadraticBezierCurve3(
            new THREE.Vector3(from.x, from.y, from.z),
            mid,
            new THREE.Vector3(to.x, to.y, to.z),
          );
          const pts = curve.getPoints(ARC);
          for (let s = 0; s < ARC; s++) {
            const o = (a * ARC + s) * 6;
            aPos.set([pts[s].x, pts[s].y, pts[s].z], o);
            aPos.set([pts[s + 1].x, pts[s + 1].y, pts[s + 1].z], o + 3);
          }
          a++;
        }
      arcGeometry.setDrawRange(0, a * ARC * 2);
      (
        arcGeometry.getAttribute("position") as THREE.BufferAttribute
      ).needsUpdate = true;
      for (const label of labels)
        label.element.dataset.on = visible[label.body.index] ? "1" : "0";
      request();
    }

    // --- interaction ------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.55 };
    const pointer = new THREE.Vector2();
    function pick(e: PointerEvent): Body | undefined {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const solidHit = raycaster.intersectObject(solidMesh, false)[0];
      const dustHit = raycaster.intersectObject(debrisPoints, false)[0];
      const best =
        solidHit && dustHit
          ? solidHit.distance <= dustHit.distance
            ? solidHit
            : dustHit
          : (solidHit ?? dustHit);
      if (!best) return undefined;
      const body =
        best.object === solidMesh
          ? solid[best.instanceId ?? -1]
          : debris[best.index ?? -1];
      if (!body) return undefined;
      const { visible } = latestVisibility();
      return visible[body.index] ? body : undefined;
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
      dirty = true,
      onScreen = true,
      disposed = false;
    function request() {
      dirty = true;
      if (!frame && onScreen) frame = requestAnimationFrame(render);
    }
    function render() {
      frame = 0;
      if (disposed || !onScreen) return;
      const moving = controls.update();
      // Labels are drawn front to back and skipped when they would land on a
      // cell another label already claimed, so the core stops piling up.
      taken.clear();
      for (const label of labels) {
        const b = label.body;
        projected.set(b.x, b.y + b.radius + 0.9, b.z).project(camera);
        const chosen = b.path === state.current.selected;
        const near = camera.position.distanceTo(controls.target) < extent * 0.9;
        const show =
          label.element.dataset.on === "1" &&
          (chosen || b.bodyClass === "star" || near) &&
          Math.abs(projected.x) < 0.97 &&
          Math.abs(projected.y) < 0.96 &&
          projected.z < 1;
        const sx = (projected.x * 0.5 + 0.5) * stage.clientWidth,
          sy = (-projected.y * 0.5 + 0.5) * stage.clientHeight;
        const cell = `${Math.round(sx / 92)}:${Math.round(sy / 18)}`;
        const free = chosen || !taken.has(cell);
        if (free) taken.add(cell);
        label.element.style.display = show && free ? "block" : "none";
        if (show && free)
          label.element.style.transform = `translate(${sx}px,${sy}px) translate(-50%,-100%)`;
        label.element.classList.toggle("is-selected", chosen);
      }
      renderer.render(scene, camera);
      dirty = false;
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
      if (e.key === "+") s.radius = Math.max(1.5, s.radius * 0.85);
      if (e.key === "-") s.radius = Math.min(extent * 6, s.radius / 0.85);
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
    reset();
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
    // `dirty` is written by request() and read by render(); the linter cannot
    // see the closure, so it is intentionally left out of the dependency list.
  }, [galaxy, failed]);

  useEffect(() => {
    api.current?.sync();
  }, [filters, selected, search, relevant]);
  // Only pan for selections the viewer makes; the page opens on the whole map.
  const firstSelection = useRef(true);
  useEffect(() => {
    if (firstSelection.current) {
      firstSelection.current = false;
      return;
    }
    if (selected) api.current?.focus(selected);
  }, [selected]);

  const counts = useMemo(() => {
    const c = { star: 0, planet: 0, moon: 0, debris: 0 };
    for (const b of galaxy.bodies) if (shown.visible[b.index]) c[b.bodyClass]++;
    return c;
  }, [galaxy, shown]);

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
        aria-label={`Repository galaxy. ${visibleCount} of ${galaxy.bodies.length} files shown. Drag to orbit, scroll to approach, arrow keys rotate, plus and minus zoom, Home resets. Use the Components view for a list.`}
      />
      <GalaxyFilters
        galaxy={galaxy}
        filters={filters}
        onFilters={onFilters}
        visible={visibleCount}
      />
      <div className="galaxy-legend">
        <h4>Body type follows relational weight</h4>
        <ul>
          <li>
            <i className="dot star" /> Star · {galaxy.cuts.star}+ incoming ·{" "}
            {counts.star}
          </li>
          <li>
            <i className="dot planet" /> Planet · {galaxy.cuts.planet}+ incoming
            · {counts.planet}
          </li>
          <li>
            <i className="dot moon" /> Moon · linked at least once ·{" "}
            {counts.moon}
          </li>
          <li>
            <i className="dot debris" /> Debris · no resolved links ·{" "}
            {counts.debris}
          </li>
        </ul>
        <p>
          Distance from the core is inverse to importance. Gold links are
          imports, blue links are tests.
        </p>
      </div>
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
  visible,
}: {
  galaxy: Galaxy;
  filters: Filters;
  onFilters: (next: Filters) => void;
  visible: number;
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
    !!filters.focus;
  return (
    <div className={`galaxy-filters${open ? "" : " collapsed"}`}>
      <button className="filters-head" onClick={() => setOpen(!open)}>
        <span>Filters</span>
        <small>
          {visible.toLocaleString()} / {galaxy.bodies.length.toLocaleString()}{" "}
          files
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
            <h5>Importance</h5>
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
          </section>
          <section>
            <h5>Subsystem</h5>
            <div className="chips">
              {galaxy.regions.slice(0, 14).map((r) => (
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
          </section>
          <section>
            <h5>File type</h5>
            <div className="chips">
              {galaxy.categories.map((c) => (
                <button
                  key={c.name}
                  className={
                    filters.categories.includes(c.name) ? "chip on" : "chip"
                  }
                  onClick={() =>
                    set({ categories: toggle(filters.categories, c.name) })
                  }
                >
                  <i style={{ background: categoryColors[c.name] }} />
                  {c.name}
                  <em>{c.count}</em>
                </button>
              ))}
            </div>
          </section>
          {galaxy.kinds.length > 1 && (
            <section>
              <h5>Relationship</h5>
              <div className="chips">
                {galaxy.kinds.map((k) => (
                  <button
                    key={k}
                    className={
                      filters.edgeKinds.includes(k) ? "chip on" : "chip"
                    }
                    onClick={() =>
                      set({ edgeKinds: toggle(filters.edgeKinds, k) })
                    }
                  >
                    {k}
                  </button>
                ))}
              </div>
            </section>
          )}
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
          {dirty && (
            <button
              className="filters-reset"
              onClick={() =>
                onFilters({ ...defaultFilters, colorMode: filters.colorMode })
              }
            >
              Reset filters — {visible.toLocaleString()} of{" "}
              {galaxy.bodies.length.toLocaleString()} files shown
            </button>
          )}
        </div>
      )}
    </div>
  );
}
