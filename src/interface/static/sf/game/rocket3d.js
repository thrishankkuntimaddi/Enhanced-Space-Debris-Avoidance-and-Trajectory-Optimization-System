// Procedural rocket models built from the vehicle database (real lengths and diameters, metres).
import * as THREE from 'three';

export function propellantOf(engine = '') {
  const e = engine.toLowerCase();
  if (e.includes('solid')) return 'solid';
  if (e.includes('vulcain') || e.includes('vinci')) return 'hydrolox';
  if (e.includes('merlin') || e.includes('rutherford') || e.includes('rd-10') || e.includes('rd-0124')) return 'kerolox';
  return 'hypergolic';
}

const PLUME = {
  kerolox: { core: 0xfff3c4, mid: 0xff9a2e, alpha: 1.0 },
  solid: { core: 0xffffff, mid: 0xffc46b, alpha: 1.0 },
  hydrolox: { core: 0xd8ecff, mid: 0x6aa8ff, alpha: 0.55 },
  hypergolic: { core: 0xffe2c0, mid: 0xff7a4a, alpha: 0.6 },
};

function mat(color, opts = {}) { return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15, ...opts }); }

function cylinder(r1, r2, h, color, seg = 32) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg, 1), mat(color));
  m.castShadow = false;
  return m;
}

function bell(r, h, color) {
  const g = new THREE.CylinderGeometry(r * 0.35, r, h, 20, 1, true);
  const m = new THREE.Mesh(g, mat(color, { metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide }));
  return m;
}

function ogive(r, h, color) {
  const pts = [];
  for (let i = 0; i <= 16; i++) { const t = i / 16; pts.push(new THREE.Vector2(r * Math.sqrt(1 - t * t * 0.98), t * h)); }
  return new THREE.Mesh(new THREE.LatheGeometry(pts, 32), mat(color));
}

export function plumeMaterial(kind) {
  const p = PLUME[kind] || PLUME.kerolox;
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uCore: { value: new THREE.Color(p.core) }, uMid: { value: new THREE.Color(p.mid) }, uAlpha: { value: p.alpha }, uTime: { value: 0 }, uVac: { value: 0 } },
    vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv;
 #include <logdepthbuf_vertex>
 }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
uniform vec3 uCore; uniform vec3 uMid; uniform float uAlpha; uniform float uTime; uniform float uVac;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
 #include <logdepthbuf_fragment>

        float along = vUv.y;                       // 1 at nozzle, 0 at tail
        float rim = pow(abs(dot(vN, vV)), 1.4);
        float flick = 0.85 + 0.15 * sin(uTime * 60.0 + along * 30.0);
        float diamonds = (1.0 - uVac) * 0.25 * pow(max(0.0, sin(along * 40.0)), 6.0);
        vec3 col = mix(uMid, uCore, smoothstep(0.35, 1.0, along) + diamonds);
        float a = uAlpha * rim * pow(along, 1.5 + uVac) * flick * (1.0 - 0.5 * uVac);
        gl_FragColor = vec4(col * (1.4 + diamonds), a);
      }`,
  });
}

/** Build the stack. Returns { group, stageGroups, boosterGroups, fairing, nozzles(stageIdx) }.
 *  Local +Y is the rocket axis; y = 0 is the exit plane of the bottom stage's engines. */
export function buildRocket(v) {
  const group = new THREE.Group();
  const stack = new THREE.Group();
  group.add(stack);
  const c = v.colors;
  const stageGroups = [];
  const offsets = [];
  let y = 0;
  v.stages.forEach((s, i) => {
    const g = new THREE.Group();
    const r = s.diameter / 2;
    const engineH = Math.min(3, s.length * 0.12 + 0.3);
    const body = cylinder(r, r, s.length, i === 0 ? c.body : c.body);
    body.position.y = engineH + s.length / 2;
    g.add(body);
    // interstage band / accent ring
    const band = cylinder(r * 1.01, r * 1.01, Math.min(2.5, s.length * 0.12), c.accent);
    band.position.y = engineH + s.length - Math.min(2.5, s.length * 0.12) / 2;
    g.add(band);
    if (i === 0) { const skirt = cylinder(r * 1.02, r * 1.05, 1.2, c.accent); skirt.position.y = engineH + 0.6; g.add(skirt); }
    // engines
    const n = /9 ×/.test(s.engine) ? 9 : /4 ×|2 ×/.test(s.engine) ? (s.engine.startsWith('4') ? 4 : 2) : 1;
    const er = n === 1 ? r * 0.55 : r * (n === 9 ? 0.22 : 0.32);
    const ring = n === 1 ? [[0, 0]] : n === 9 ? [[0, 0], ...Array.from({ length: 8 }, (_, k) => [Math.cos(k * Math.PI / 4) * r * 0.62, Math.sin(k * Math.PI / 4) * r * 0.62])]
      : Array.from({ length: n }, (_, k) => [Math.cos(k * 2 * Math.PI / n) * r * 0.45, Math.sin(k * 2 * Math.PI / n) * r * 0.45]);
    const nozzles = [];
    for (const [x, z] of ring) { const b = bell(er, engineH, c.engine); b.position.set(x, engineH / 2, z); g.add(b); nozzles.push(new THREE.Vector3(x, 0, z)); }
    g.userData = { nozzles, engineR: er * n ** 0.5, kind: propellantOf(s.engine), length: s.length + engineH, radius: r };
    g.position.y = y;
    offsets.push(y);
    y += s.length + engineH;
    stack.add(g);
    stageGroups.push(g);
  });
  // payload fairing (or capsule-shaped nose)
  const fr = v.fairing.diameter / 2, fl = v.fairing.length;
  const fairing = new THREE.Group();
  const cyl = cylinder(fr, Math.max(fr, v.stages[v.stages.length - 1].diameter / 2), fl * 0.45, c.body);
  cyl.position.y = fl * 0.225; fairing.add(cyl);
  const nose = ogive(fr, fl * 0.55, c.body); nose.position.y = fl * 0.45; fairing.add(nose);
  fairing.position.y = y;
  stack.add(fairing);
  // boosters
  const boosterGroups = [];
  if (v.boosters) {
    const b = v.boosters, R = v.stages[0].diameter / 2 + b.diameter / 2 + 0.05;
    for (let k = 0; k < b.count; k++) {
      const g = new THREE.Group();
      const ang = (k / b.count) * Math.PI * 2;
      const engineH = 1.4;
      let body;
      if (b.style === 'cone') {   // Soyuz: tapered strap-ons
        body = cylinder(b.diameter * 0.18, b.diameter / 2, b.length, c.accent);
      } else body = cylinder(b.diameter / 2, b.diameter / 2, b.length, k % 2 ? c.body : c.body);
      body.position.y = engineH + b.length / 2;
      g.add(body);
      if (b.style !== 'cone') { const nc = ogive(b.diameter / 2, b.diameter * 1.6, c.accent); nc.position.y = engineH + b.length; g.add(nc); }
      const bl = bell(b.diameter * 0.32, engineH, c.engine); bl.position.y = engineH / 2; g.add(bl);
      g.position.set(Math.cos(ang) * R, 0, Math.sin(ang) * R);
      g.userData = { nozzles: [new THREE.Vector3(0, 0, 0)], engineR: b.diameter * 0.32, kind: propellantOf(b.engine), airLit: b.airLit && k >= b.count - b.airLit };
      stack.add(g);
      boosterGroups.push(g);
    }
  }
  return { group, stack, stageGroups, offsets, boosterGroups, fairing, totalLength: y + fl };
}

/** Exhaust plumes for a set of nozzles: returns { group, update(throttle, pressureRatio, time) }. */
export function makePlume(nozzles, engineR, kind) {
  const group = new THREE.Group();
  const matr = plumeMaterial(kind);
  const meshes = nozzles.map((p) => {
    const g = new THREE.ConeGeometry(1, 1, 24, 1, true);
    g.translate(0, -0.5, 0);
    const m = new THREE.Mesh(g, matr);
    m.position.copy(p);
    group.add(m);
    return m;
  });
  const glow = new THREE.PointLight(PLUME[kind]?.mid ?? 0xffa040, 0, 300, 1.4);
  glow.position.y = -engineR * 3;
  group.add(glow);
  return {
    group,
    update(throttle, pRatio, time) {
      const vac = 1 - Math.min(1, pRatio);
      matr.uniforms.uTime.value = time;
      matr.uniforms.uVac.value = vac;
      for (const m of meshes) {
        const on = throttle > 0.01;
        m.visible = on;
        // under-expanded plume balloons as ambient pressure falls (physically: exit pressure > ambient)
        const len = engineR * (16 + 30 * throttle) * (1 + 2.5 * vac);
        const wid = engineR * (1.1 + 6.5 * vac * vac) * (0.7 + 0.3 * throttle);
        m.scale.set(wid, len, wid);
      }
      glow.intensity = throttle > 0.01 ? 500 * throttle * (1 - 0.8 * vac) : 0;
    },
  };
}
