import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import SoftwareOrbit from "./SoftwareOrbit";
import type { MapData } from "./Galaxy";
import { orbitLayout, hash } from "./orbit-layout";
const vertex = `varying vec3 vNormal; varying vec3 vPosition; varying vec2 vUv; void main(){vUv=uv;vNormal=normalize(normalMatrix*normal);vPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const fragment = `precision highp float; varying vec3 vNormal; varying vec3 vPosition; varying vec2 vUv; uniform vec3 tint; uniform float seed; uniform float star; uniform float bands; uniform float emphasis;
float h(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
float n(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z);}
void main(){vec3 p=vPosition*5.+seed;float f=n(p)*.6+n(p*2.)*.25+n(p*5.)*.15;float stripe=sin(vUv.y*90.+f*12.)*.5+.5;float texture=mix(f,stripe,bands);float light=max(dot(normalize(vNormal),normalize(vec3(-.7,.8,1.))),0.);float rim=pow(1.-max(vNormal.z,0.),3.);vec3 rock=tint*(.25+.75*texture)*(.14+light*1.05)+tint*rim*.14;vec3 sun=mix(tint,vec3(1.,.91,.72),f)*(.75+f*.7);gl_FragColor=vec4(mix(rock,sun,star)*emphasis,1.);}`;
const glowFragment = `varying vec2 vUv; uniform vec3 tint; uniform float strength;void main(){float d=length(vUv-.5)*2.;float a=pow(max(0.,1.-d),3.)*strength;gl_FragColor=vec4(tint,a);}`;
type Props = {
  data: MapData;
  selected: string;
  onSelect: (id: string) => void;
  relevant: string[];
  search?: string;
};
export default function OrbitalGalaxy({
  data,
  selected,
  onSelect,
  relevant,
  search = "",
}: Props) {
  const mount = useRef<HTMLDivElement>(null),
    api = useRef<
      | {
          reset: () => void;
          top: () => void;
          spin: (v: boolean) => void;
          focus: (id: string) => void;
        }
      | undefined
    >(undefined);
  const [page, setPage] = useState(0);
  const [region, setRegion] = useState<string>(),
    [spinning, setSpinning] = useState(false),
    [failed, setFailed] = useState(false),
    [hover, setHover] = useState<{
      name: string;
      detail: string;
      x: number;
      y: number;
    }>();
  const latest = useRef({ selected, onSelect, relevant, search });
  latest.current = { selected, onSelect, relevant, search };
  const layout = useMemo(
    () => orbitLayout(data, region, page),
    [data, region, page],
  );
  useEffect(() => {
    setRegion(undefined);
    setSpinning(false);
  }, [data.id]);
  useEffect(() => {
    const host = mount.current!;
    if (!host || failed) return;
    let renderer: THREE.WebGLRenderer;
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2", {
        antialias: true,
        alpha: false,
        powerPreference: "low-power",
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
        powerPreference: "low-power",
      });
    } catch {
      setFailed(true);
      return;
    }
    setFailed(false);
    renderer.setClearColor("#111213");
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    const extent = Math.max(
      8,
      ...layout.bodies.map((b) => Math.hypot(b.x, b.z) + b.radius * 3),
    );
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.minDistance = 2;
    controls.maxDistance = extent * 7;
    controls.autoRotateSpeed = 0.45;
    controls.maxPolarAngle = Math.PI * 0.96;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0,
      dirty = true,
      visible = true,
      disposed = false,
      last = performance.now();
    const meshes: THREE.Mesh[] = [],
      byId = new Map<string, THREE.Mesh>(),
      materials: THREE.Material[] = [],
      labels: {
        element: HTMLSpanElement;
        position: THREE.Vector3;
        id: string;
      }[] = [];
    const sphere = new THREE.SphereGeometry(1, 32, 24),
      plane = new THREE.PlaneGeometry(1, 1);
    const labelLayer = document.createElement("div");
    labelLayer.className = "orbital-labels";
    host.appendChild(labelLayer);
    for (const body of layout.bodies) {
      const isStar = body.incoming >= 3 && !layout.aggregated;
      const material = new THREE.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: {
          tint: { value: new THREE.Color(body.color) },
          seed: { value: hash(body.id) % 100 },
          star: { value: isStar ? 1 : 0 },
          bands: {
            value: /config|schema|database/.test(body.region) ? 0.85 : 0.05,
          },
          emphasis: { value: 1 },
        },
      });
      materials.push(material);
      const mesh = new THREE.Mesh(sphere, material);
      mesh.position.set(body.x, body.y, body.z);
      mesh.scale.setScalar(body.radius);
      mesh.rotation.set(0.2, (hash(body.id) % 60) / 10, 0.2);
      mesh.userData = { body };
      scene.add(mesh);
      meshes.push(mesh);
      byId.set(body.id, mesh);
      if (isStar) {
        const gm = new THREE.ShaderMaterial({
          vertexShader: vertex,
          fragmentShader: glowFragment,
          uniforms: {
            tint: { value: new THREE.Color(body.color) },
            strength: { value: 0.85 },
          },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        materials.push(gm);
        const glow = new THREE.Mesh(plane, gm);
        glow.scale.setScalar(8);
        mesh.add(glow);
        glow.userData.billboard = true;
      }
      if (body.incoming >= 2) {
        const points = Array.from({ length: 97 }, (_, i) => {
          const a = (i / 96) * Math.PI * 2;
          return new THREE.Vector3(
            Math.cos(a) * body.radius * 1.75,
            0,
            Math.sin(a) * body.radius * 1.75,
          );
        });
        const mat = new THREE.LineBasicMaterial({
          color: body.color,
          transparent: true,
          opacity: 0.32,
        });
        materials.push(mat);
        const ring = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          mat,
        );
        ring.position.copy(mesh.position);
        ring.rotation.x = 0.25;
        scene.add(ring);
      }
      const label = document.createElement("span");
      label.textContent = layout.aggregated
        ? `${body.region} · ${body.count} files`
        : body.name;
      labelLayer.appendChild(label);
      labels.push({
        element: label,
        position: mesh.position
          .clone()
          .add(new THREE.Vector3(0, body.radius + 1, 0)),
        id: body.id,
      });
    }
    const edgeMaterials = new Map<
      string,
      THREE.LineBasicMaterial | THREE.LineDashedMaterial
    >();
    if (!layout.aggregated)
      for (const edge of data.edges) {
        if (edge.kind === "contains") continue;
        const from = byId.get(edge.from),
          to = byId.get(edge.to);
        if (!from || !to) continue;
        const midpoint = from.position.clone().lerp(to.position, 0.5);
        midpoint.y += from.position.distanceTo(to.position) * 0.1;
        const curve = new THREE.QuadraticBezierCurve3(
          from.position,
          midpoint,
          to.position,
        );
        const test = /test/.test(edge.kind) || /test|spec/.test(edge.from);
        const mat = test
          ? new THREE.LineDashedMaterial({
              color: "#b6ada0",
              transparent: true,
              opacity: 0.16,
              dashSize: 0.25,
              gapSize: 0.2,
            })
          : new THREE.LineBasicMaterial({
              color: "#c2a779",
              transparent: true,
              opacity: 0.18,
            });
        materials.push(mat);
        edgeMaterials.set(`${edge.from}:${edge.to}`, mat);
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curve.getPoints(32)),
          mat,
        );
        line.computeLineDistances();
        scene.add(line);
      }
    const raycaster = new THREE.Raycaster(),
      pointer = new THREE.Vector2(),
      projected = new THREE.Vector3();
    function hit(e: PointerEvent) {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(meshes, false)[0]?.object as
        THREE.Mesh | undefined;
    }
    let down = { x: 0, y: 0 };
    const pointerDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const pointerUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const mesh = hit(e);
      if (!mesh) return;
      const b = mesh.userData.body;
      if (layout.aggregated) {
        setRegion(b.region);
        setPage(0);
        setSpinning(false);
      } else latest.current.onSelect(b.id);
    };
    const pointerMove = (e: PointerEvent) => {
      if (e.buttons) {
        setHover(undefined);
        return;
      }
      const mesh = hit(e),
        rect = host.getBoundingClientRect();
      renderer.domElement.style.cursor = mesh ? "pointer" : "grab";
      setHover(
        mesh
          ? {
              name: mesh.userData.body.name,
              detail: layout.aggregated
                ? `${mesh.userData.body.count} files · select to explore`
                : `${mesh.userData.body.incoming} incoming links · ${mesh.userData.body.region}`,
              x: Math.min(e.clientX - rect.left + 16, rect.width - 220),
              y: Math.min(e.clientY - rect.top + 16, rect.height - 70),
            }
          : undefined,
      );
    };
    const leave = () => setHover(undefined);
    const reset = () => {
      controls.target.set(0, 0, 0);
      camera.position.set(extent * 0.85, extent * 0.95, extent * 1.75);
      controls.update();
      request();
    };
    function render() {
      frame = 0;
      if (disposed || !visible) return;
      const now = performance.now();
      if (controls.autoRotate && !reduce.matches)
        controls.update(Math.min((now - last) / 1000, 0.04));
      last = now;
      const focus = latest.current,
        active = new Set(focus.relevant),
        query = focus.search.toLowerCase();
      for (const mesh of meshes) {
        const b = mesh.userData.body,
          chosen = b.id === focus.selected,
          matching =
            !query || `${b.name} ${b.region}`.toLowerCase().includes(query),
          related = !active.size || active.has(b.id);
        (mesh.material as THREE.ShaderMaterial).uniforms.emphasis.value = chosen
          ? 1.7
          : !matching || !related
            ? 0.35
            : 1;
        for (const child of mesh.children)
          if (child.userData.billboard) {
            child.quaternion
              .copy(mesh.quaternion)
              .invert()
              .multiply(camera.quaternion);
          }
      }
      for (const [key, mat] of edgeMaterials) {
        const [from, to] = key.split(":");
        mat.opacity =
          from === focus.selected || to === focus.selected ? 0.6 : 0.14;
      }
      for (const label of labels) {
        projected.copy(label.position).project(camera);
        const chosen = label.id === focus.selected,
          body = byId.get(label.id)!.userData.body;
        const show =
          layout.aggregated ||
          chosen ||
          active.has(label.id) ||
          (query &&
            `${body.name} ${body.region}`.toLowerCase().includes(query)) ||
          camera.position.distanceTo(controls.target) < extent * 1.45;
        label.element.style.display =
          show &&
          Math.abs(projected.x) < 0.96 &&
          Math.abs(projected.y) < 0.95 &&
          projected.z < 1
            ? "block"
            : "none";
        label.element.style.transform = `translate(${(projected.x * 0.5 + 0.5) * host.clientWidth}px,${(-projected.y * 0.5 + 0.5) * host.clientHeight}px) translate(-50%,-100%)`;
        label.element.classList.toggle("is-selected", chosen);
      }
      renderer.render(scene, camera);
      dirty = false;
      if (controls.autoRotate && !reduce.matches) request();
    }
    function request() {
      dirty = true;
      if (!frame && visible) frame = requestAnimationFrame(render);
    }
    const resize = new ResizeObserver(() => {
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      request();
    });
    resize.observe(host);
    const visibility = () => {
      visible = !document.hidden;
      if ((visible && dirty) || (visible && controls.autoRotate)) request();
    };
    document.addEventListener("visibilitychange", visibility);
    const reduced = () => {
      if (reduce.matches) {
        controls.autoRotate = false;
        setSpinning(false);
      }
      request();
    };
    reduce.addEventListener("change", reduced);
    const keyboard = (e: KeyboardEvent) => {
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
      controls.autoRotate = false;
      setSpinning(false);
      if (e.key === "Home") reset();
      else {
        const offset = camera.position.clone().sub(controls.target),
          s = new THREE.Spherical().setFromVector3(offset);
        if (e.key === "ArrowLeft") s.theta -= 0.12;
        if (e.key === "ArrowRight") s.theta += 0.12;
        if (e.key === "ArrowUp") s.phi = Math.max(0.05, s.phi - 0.12);
        if (e.key === "ArrowDown")
          s.phi = Math.min(Math.PI - 0.05, s.phi + 0.12);
        if (e.key === "+") s.radius = Math.max(2, s.radius * 0.85);
        if (e.key === "-") s.radius = Math.min(extent * 7, s.radius / 0.85);
        camera.position.copy(
          new THREE.Vector3().setFromSpherical(s).add(controls.target),
        );
        controls.update();
        request();
      }
    };
    host.addEventListener("keydown", keyboard);
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointermove", pointerMove);
    renderer.domElement.addEventListener("pointerleave", leave);
    controls.addEventListener("change", request);
    const lost = (e: Event) => {
      e.preventDefault();
      setFailed(true);
      controls.autoRotate = false;
    };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    api.current = {
      reset,
      top: () => {
        camera.position.set(0, extent * 2.2, 0.01);
        controls.target.set(0, 0, 0);
        controls.update();
        request();
      },
      spin: (v) => {
        controls.autoRotate = v && !reduce.matches;
        if (reduce.matches) setSpinning(false);
        request();
      },
      focus: (id) => {
        const m = byId.get(id);
        if (m && latest.current.search) {
          controls.target.copy(m.position);
          controls.update();
        }
        request();
      },
    };
    reset();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      document.removeEventListener("visibilitychange", visibility);
      reduce.removeEventListener("change", reduced);
      host.removeEventListener("keydown", keyboard);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerleave", leave);
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line)
          o.geometry.dispose();
      });
      for (const m of materials) m.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelLayer.remove();
      api.current = undefined;
    };
  }, [data, layout, failed]);
  useEffect(() => {
    api.current?.focus(selected);
  }, [selected, relevant, search]);
  if (failed)
    return (
      <SoftwareOrbit
        data={data}
        selected={selected}
        onSelect={onSelect}
        relevant={relevant}
        search={search}
      />
    );
  return (
    <div className="orbital-view">
      <div className="orbital-caption">
        <span>{region || "Repository orbit"}</span>
        <small>
          {layout.aggregated
            ? `${layout.bodies.length} regions · ${data.files} real files`
            : `${layout.bodies.length} of ${layout.total} file bodies`}
        </small>
      </div>
      {layout.pages > 1 && (
        <div className="orbital-paging">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>
            Page {page + 1} / {layout.pages}
          </span>
          <button
            disabled={page + 1 >= layout.pages}
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
      <div
        ref={mount}
        className="orbital-canvas"
        tabIndex={0}
        role="group"
        aria-label="3D repository map. Drag to rotate; pinch to zoom; two fingers to pan. Keyboard: arrows rotate, plus and minus zoom, Home resets. Use Components for the accessible list."
      />
      {hover && (
        <div
          className="orbital-tooltip"
          style={{ left: hover.x, top: hover.y }}
        >
          <strong>{hover.name}</strong>
          <small>{hover.detail}</small>
        </div>
      )}
      {failed && (
        <div className="orbital-fallback" role="status">
          3D rendering is unavailable on this device. Select Heatmap or
          Components above to explore the same repository.
        </div>
      )}
      <div className="orbital-controls">
        <span>
          Drag to orbit <b>·</b> Scroll to approach
        </span>
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
            {spinning ? "Pause spin" : "Spin"}
          </button>
          <button onClick={() => api.current?.reset()}>Reset</button>
        </div>
      </div>
    </div>
  );
}
