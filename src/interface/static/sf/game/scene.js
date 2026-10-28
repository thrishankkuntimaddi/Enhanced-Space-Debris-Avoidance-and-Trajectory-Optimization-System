// Rendering: one WebGL canvas, two scenes.
//   GLOBE  (units = 1000 km): Earth, the whole catalog animated on the GPU, trajectories, conjunctions.
//   LOCAL  (units = metres, floating origin at the vehicle): rocket, plumes, smoke, pad, spent stages,
//          the curved Earth below and the sky darkening with altitude.
// Frames: physics is TEME (z = spin axis). three.js is y-up, so TEME (x, y, z) -> three (x, z, -y).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildRocket, makePlume } from './rocket3d.js';
import { atmosphere } from '../physics/atmosphere.js';
import { RE, MU_KM, J2, OMEGA_E } from '../physics/constants.js';
import { gmst, julian } from '../physics/time.js';

const K = 1e-6;                         // metres -> globe units (1000 km)
export const toThree = (p, s = 1) => new THREE.Vector3(p[0] * s, p[2] * s, -p[1] * s);
const setThree = (v, x, y, z, s = 1) => v.set(x * s, z * s, -y * s);

export function sunDirection(date) {   // low-precision solar ephemeris (Astronomical Almanac), TEME-ish
  const n = julian(date) - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * Math.PI / 180, g = (357.528 + 0.9856003 * n) * Math.PI / 180;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const eps = (23.439 - 4e-7 * n) * Math.PI / 180;
  return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}

function softDot() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function atmosphereShell(radius, color = 0x4aa8ff, power = 3.0, strength = 1.1) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uPow: { value: power }, uK: { value: strength } },
    vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN; varying vec3 vP; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.); vP = mv.xyz; gl_Position = projectionMatrix*mv;
 #include <logdepthbuf_vertex>
 }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
uniform vec3 uColor; uniform float uPow; uniform float uK; varying vec3 vN; varying vec3 vP;
      void main(){
 #include <logdepthbuf_fragment>
 float f = pow(max(0.0, 1.0 - abs(dot(normalize(-vP), vN))), uPow) * uK; gl_FragColor = vec4(uColor, f); }`,
  }));
}

function earthMaterial(tex) {
  return new THREE.MeshPhongMaterial({ map: tex, shininess: 12, specular: new THREE.Color(0x223344) });
}

// ── GPU catalog: two-body + J2 secular drift evaluated in the vertex shader ─────────────────
function parseElements(row, baseMs) {
  const l1 = row[9], l2 = row[10];
  const yy = +l1.slice(18, 20), doy = +l1.slice(20, 32);
  const epochMs = Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (doy - 1) * 86400000;
  const inc = +l2.slice(8, 16) * Math.PI / 180, raan = +l2.slice(17, 25) * Math.PI / 180;
  const e = +('0.' + l2.slice(26, 33).trim()), argp = +l2.slice(34, 42) * Math.PI / 180;
  const M = +l2.slice(43, 51) * Math.PI / 180, nRev = +l2.slice(52, 63);
  const n = nRev * 2 * Math.PI / 86400, a = Math.cbrt(MU_KM / (n * n));
  const p = a * (1 - e * e), f = 1.5 * J2 * (6378.137 / p) ** 2 * n;
  const dRaan = -f * Math.cos(inc), dArgp = 0.5 * f * (5 * Math.cos(inc) ** 2 - 1);
  const dt = (baseMs - epochMs) / 1000;
  return { a: a / 1000, e, inc, raan: raan + dRaan * dt, argp: argp + dArgp * dt, M: (M + n * dt) % (2 * Math.PI), n, dRaan, dArgp };
}

export class CatalogCloud {
  constructor(rows, baseMs) {
    this.baseMs = baseMs;
    const N = rows.length;
    const el1 = new Float32Array(N * 4), el2 = new Float32Array(N * 4), el3 = new Float32Array(N * 2), color = new Float32Array(N * 3);
    const col = { PAYLOAD: [0.35, 0.92, 0.85], 'ROCKET BODY': [1.0, 0.72, 0.28], DEBRIS: [1.0, 0.36, 0.42], UNKNOWN: [0.6, 0.66, 0.75] };
    this.index = [];
    rows.forEach((r, i) => {
      const o = parseElements(r, baseMs);
      el1.set([o.a, o.e, o.inc, o.raan], 4 * i);
      el2.set([o.argp, o.M, o.n, o.dRaan], 4 * i);
      el3.set([o.dArgp, r[2] === 'DEBRIS' ? 1 : 0], 2 * i);
      color.set(col[r[2]] || col.UNKNOWN, 3 * i);
      this.index.push(r);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('el1', new THREE.BufferAttribute(el1, 4));
    g.setAttribute('el2', new THREE.BufferAttribute(el2, 4));
    g.setAttribute('el3', new THREE.BufferAttribute(el3, 2));
    g.setAttribute('color', new THREE.BufferAttribute(color, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uT: { value: 0 }, uSize: { value: 2.0 }, uTex: { value: softDot() }, uFocus: { value: 1 } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 el1; attribute vec4 el2; attribute vec2 el3; attribute vec3 color;
        uniform float uT; uniform float uSize; varying vec3 vC;
        void main(){
          float a = el1.x, e = el1.y, inc = el1.z, raan = el1.w + el2.w * uT, argp = el2.x + el3.x * uT;
          float M = mod(el2.y + el2.z * uT, 6.2831853);
          float E = M + e * sin(M);
          for (int k = 0; k < 5; k++) E = E - (E - e * sin(E) - M) / (1.0 - e * cos(E));
          float xv = a * (cos(E) - e), yv = a * sqrt(1.0 - e*e) * sin(E);
          float cO = cos(raan), sO = sin(raan), cw = cos(argp), sw = sin(argp), ci = cos(inc), si = sin(inc);
          float x = (cO*cw - sO*sw*ci) * xv + (-cO*sw - sO*cw*ci) * yv;
          float y = (sO*cw + cO*sw*ci) * xv + (-sO*sw + cO*cw*ci) * yv;
          float z = (sw*si) * xv + (cw*si) * yv;
          vec4 mv = modelViewMatrix * vec4(x, z, -y, 1.0);
          gl_Position = projectionMatrix * mv;
 #include <logdepthbuf_vertex>

          gl_PointSize = uSize * (1.0 + 18.0 / max(-mv.z, 1.0));
          vC = color;
        }`,
      fragmentShader: `#include <logdepthbuf_pars_fragment>
uniform sampler2D uTex; varying vec3 vC; void main(){
 #include <logdepthbuf_fragment>
 vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vC, t.a * 0.85); }`,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
  }
  setTime(dateMs) { this.material.uniforms.uT.value = (dateMs - this.baseMs) / 1000; }
}

// ── the renderer ────────────────────────────────────────────────────────────
export class Views {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.tex = new THREE.TextureLoader().load('/static/images/earth_2048.jpg');
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.mode = 'globe';
    this._initGlobe();
    this._initLocal();
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    for (const c of [this.gCam, this.lCam]) { c.aspect = w / h; c.updateProjectionMatrix(); }
  }

  // ── globe ──
  _initGlobe() {
    const s = this.gScene = new THREE.Scene();
    s.background = new THREE.Color(0x02040a);
    this.gCam = new THREE.PerspectiveCamera(42, 1, 0.001, 2000);
    this.gCam.position.set(16, 8, 22);
    this.controls = new OrbitControls(this.gCam, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.minDistance = 6.6; this.controls.maxDistance = 140;
    this.gSun = new THREE.DirectionalLight(0xffffff, 2.6);
    s.add(this.gSun, new THREE.AmbientLight(0x6688aa, 0.35));
    this.gEarth = new THREE.Mesh(new THREE.SphereGeometry(RE * K, 128, 96), earthMaterial(this.tex));
    s.add(this.gEarth);
    s.add(atmosphereShell(RE * K * 1.02, 0x4aa8ff, 5.0, 0.55));
    const n = 4000, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(600 + Math.random() * 400); a.set([v.x, v.y, v.z], 3 * i); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3));
    s.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fb3c8, size: 1.2, sizeAttenuation: false })));
    this.gLayer = new THREE.Group(); s.add(this.gLayer);
    this.vehMarker = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), new THREE.MeshBasicMaterial({ color: 0x38e1ff }));
    this.vehHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot(), color: 0x38e1ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.vehHalo.scale.setScalar(0.35);
    this.vehMarker.add(this.vehHalo);
    this.vehMarker.visible = false;
    s.add(this.vehMarker);
  }

  setCatalog(cloud) {
    if (this.cloud) this.gScene.remove(this.cloud.points);
    this.cloud = cloud;
    this.gScene.add(cloud.points);
  }

  clearGlobeLayer() { this.gLayer.clear(); }

  /** Polyline from a Path-like (r in km, 3n floats) or array of [x,y,z] km. */
  line(points, color, opacity = 1, dashed = false) {
    const pts = [];
    if (points.r) for (let i = 0; i < points.n; i++) pts.push(toThree([points.r[3 * i], points.r[3 * i + 1], points.r[3 * i + 2]], 1e-3));
    else for (const p of points) pts.push(toThree(p, 1e-3));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = dashed ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.08, gapSize: 0.06 })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const l = new THREE.Line(g, m);
    if (dashed) l.computeLineDistances();
    this.gLayer.add(l);
    return l;
  }

  marker(posKm, color, size = 0.05) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(size * 0.5, 12, 8), new THREE.MeshBasicMaterial({ color }));
    const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    h.scale.setScalar(size * 5); m.add(h);
    m.position.copy(toThree(posKm, 1e-3));
    this.gLayer.add(m);
    return m;
  }

  // ── local (launch) ──
  _initLocal() {
    const s = this.lScene = new THREE.Scene();
    this.lCam = new THREE.PerspectiveCamera(55, 1, 0.5, 4e7);
    this.lSun = new THREE.DirectionalLight(0xffffff, 3.2);
    s.add(this.lSun, this.lSun.target);
    this.lAmb = new THREE.HemisphereLight(0xbfd8ff, 0x3a3020, 0.9);
    s.add(this.lAmb);
    this.lEarth = new THREE.Mesh(new THREE.SphereGeometry(RE, 256, 192), earthMaterial(this.tex));
    s.add(this.lEarth);
    this.lAtmo = atmosphereShell(RE * 1.015, 0x5fb0ff, 4.0, 0.9);
    s.add(this.lAtmo);
    this.lStars = (() => {
      const n = 3000, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(3e7); a.set([v.x, v.y, v.z], 3 * i); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3));
      return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.3, sizeAttenuation: false, transparent: true, opacity: 0 }));
    })();
    s.add(this.lStars);
    // smoke
    this.smokeN = 900;
    this.smoke = { pos: new Float64Array(this.smokeN * 3), age: new Float32Array(this.smokeN).fill(1e9), size: new Float32Array(this.smokeN), head: 0 };
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.smokeN * 3), 3));
    sg.setAttribute('size', new THREE.BufferAttribute(new Float32Array(this.smokeN), 1));
    sg.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(this.smokeN), 1));
    this.smokePts = new THREE.Points(sg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTex: { value: softDot() }, uScale: { value: innerHeight } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
attribute float size; attribute float alpha; varying float vA; uniform float uScale;
        void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); gl_Position = projectionMatrix*mv;
 #include <logdepthbuf_vertex>
 gl_PointSize = min(900.0, size * uScale / max(-mv.z, 1.0)); vA = alpha; }`,
      fragmentShader: `#include <logdepthbuf_pars_fragment>
uniform sampler2D uTex; varying float vA; void main(){
 #include <logdepthbuf_fragment>
 vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vec3(0.86,0.85,0.83), t.a * vA); }`,
    }));
    this.smokePts.frustumCulled = false;
    s.add(this.smokePts);
    // pad
    this.pad = new THREE.Group();
    const conc = new THREE.Mesh(new THREE.CylinderGeometry(160, 160, 2, 48), new THREE.MeshStandardMaterial({ color: 0x8c8c86, roughness: 0.95 }));
    conc.position.y = -1; this.pad.add(conc);
    const land = new THREE.Mesh(new THREE.CircleGeometry(6000, 64), new THREE.MeshStandardMaterial({ color: 0x4d5a3a, roughness: 1 }));
    land.rotation.x = -Math.PI / 2; land.position.y = -2.2; this.pad.add(land);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(8, 90, 8), new THREE.MeshStandardMaterial({ color: 0x7a3a2a, roughness: 0.8, wireframe: false }));
    tower.position.set(-18, 45, 0); this.pad.add(tower);
    for (let k = 0; k < 4; k++) {
      const lt = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 110, 8), new THREE.MeshStandardMaterial({ color: 0x9aa0a6 }));
      lt.position.set(Math.cos(k * Math.PI / 2 + 0.6) * 120, 55, Math.sin(k * Math.PI / 2 + 0.6) * 120); this.pad.add(lt);
    }
    s.add(this.pad);
    this.clouds = new THREE.Group();
    const cm = new THREE.SpriteMaterial({ map: softDot(), color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
    for (let k = 0; k < 40; k++) {
      const c = new THREE.Sprite(cm);
      const a = Math.random() * Math.PI * 2, d = 800 + Math.random() * 14000;
      c.position.set(Math.cos(a) * d, 1500 + Math.random() * 5000, Math.sin(a) * d);
      c.scale.set(2500 + Math.random() * 3000, 900 + Math.random() * 700, 1);
      this.clouds.add(c);
    }
    this.pad.add(this.clouds);
    this.spentMeshes = new Map();
    this.camMode = 'chase';
    this.orbit = { yaw: 0.6, pitch: 0.12, dist: 1 };
    let drag = null;
    this.renderer.domElement.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; });
    addEventListener('pointerup', () => { drag = null; });
    addEventListener('pointermove', (e) => {
      if (!drag || this.mode !== 'local') return;
      this.orbit.yaw -= (e.clientX - drag[0]) * 0.005; this.orbit.pitch = Math.max(-1.4, Math.min(1.4, this.orbit.pitch + (e.clientY - drag[1]) * 0.004));
      drag = [e.clientX, e.clientY];
    });
    this.renderer.domElement.addEventListener('wheel', (e) => { if (this.mode === 'local') this.orbit.dist = Math.max(0.35, Math.min(40, this.orbit.dist * (1 + Math.sign(e.deltaY) * 0.1))); }, { passive: true });
  }

  attachVehicle(veh) {
    if (this.rocket) this.lScene.remove(this.rocket.group);
    this.rocket = buildRocket(veh);
    this.lScene.add(this.rocket.group);
    this.plumes = this.rocket.stageGroups.map((g) => { const p = makePlume(g.userData.nozzles, g.userData.engineR, g.userData.kind); g.add(p.group); return p; });
    this.boosterPlumes = this.rocket.boosterGroups.map((g) => { const p = makePlume(g.userData.nozzles, g.userData.engineR, g.userData.kind); g.add(p.group); return p; });
    this.spentMeshes.forEach((m) => this.lScene.remove(m));
    this.spentMeshes.clear();
    this.smoke.age.fill(1e9);
    this.orbit.dist = 1;
    this.shownStage = 0;
  }

  /** Update the local scene from the flight simulator. */
  updateLocal(sim, time) {
    const r = sim.r;
    const up = toThree(r).normalize();
    const theta = sim.theta;
    // Earth: centre at -r, rotated by GMST
    this.lEarth.position.copy(toThree(r).multiplyScalar(-1));
    this.lEarth.rotation.y = theta;
    this.lAtmo.position.copy(this.lEarth.position);
    const env = sim.environment(sim.r, sim.v);
    const alt = env.h;
    // sky: blue near the ground, black above ~60 km, sun-angle aware
    const sun = toThree(sunDirection(sim.date)).normalize();
    const day = Math.max(0, Math.min(1, up.dot(sun) * 3 + 0.4));
    const thick = Math.max(0, 1 - alt / 60000) ** 1.5;
    const sky = new THREE.Color(0x05070d).lerp(new THREE.Color(0x6fa8e6), thick * day);
    this.lScene.background = sky;
    this.lStars.material.opacity = Math.max(0, 1 - thick * day * 3);
    this.lSun.position.copy(sun).multiplyScalar(1e5);
    this.lAmb.intensity = 0.25 + 0.8 * thick * day;
    // rocket attitude
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), toThree(sim.att).normalize());
    this.rocket.group.quaternion.copy(q);
    // stage visibility + stack offset
    const R = this.rocket;
    if (this.shownStage !== sim.stage) {
      for (let i = 0; i < sim.stage; i++) R.stageGroups[i].visible = false;
      this.shownStage = sim.stage;
    }
    R.stack.position.y = -R.offsets[sim.stage];
    R.fairing.visible = sim.fairing;
    sim.boosterGroups.forEach((g, gi) => {
      const groupMeshes = R.boosterGroups.filter((m, k) => (gi === 0 ? !m.userData.airLit : m.userData.airLit));
      groupMeshes.forEach((m) => { m.visible = g.attached; });
    });
    // plumes
    const pr = env.atm.p / 101325;
    const engs = sim.engines();
    const stageOn = engs.find((e) => e.kind === 'stage');
    this.plumes.forEach((p, i) => p.update(i === sim.stage && stageOn ? Math.max(0.15, sim.throttle) : 0, pr, time));
    this.boosterPlumes.forEach((p, k) => {
      const m = R.boosterGroups[k];
      const grp = sim.boosterGroups[m.userData.airLit ? 1 : 0];
      p.update(grp && grp.attached && grp.lit && grp.prop > 0 ? 1 : 0, pr, time);
    });
    // smoke: emitted while there is enough air to make a visible trail
    if (engs.length && alt < 45000 && sim.phase !== 'PAD') {
      const axis = toThree(sim.att).normalize();
      const emit = Math.min(6, 1 + engs.length * 2);
      for (let k = 0; k < emit; k++) {
        const i = this.smoke.head++ % this.smokeN;
        const back = -(5 + Math.random() * 30);
        // stored in inertial metres relative to Earth centre (three axes), so the trail stays put
        this.smoke.pos[3 * i] = r[0] + axis.x * back; this.smoke.pos[3 * i + 1] = r[2] + axis.y * back; this.smoke.pos[3 * i + 2] = -r[1] + axis.z * back;
        this.smoke.age[i] = 0;
        this.smoke.size[i] = (R.stageGroups[0].userData.radius || 2) * (4 + Math.random() * 4) * (1 + alt / 8000);
      }
    }
    const sp = this.smokePts.geometry.attributes.position, ss = this.smokePts.geometry.attributes.size, sa = this.smokePts.geometry.attributes.alpha;
    const rx = r[0], ry = r[2], rz = -r[1];
    for (let i = 0; i < this.smokeN; i++) {
      const a = this.smoke.age[i];
      if (a > 90) { sa.array[i] = 0; continue; }
      this.smoke.age[i] += this._dt || 0.016;
      sp.array[3 * i] = this.smoke.pos[3 * i] - rx; sp.array[3 * i + 1] = this.smoke.pos[3 * i + 1] - ry; sp.array[3 * i + 2] = this.smoke.pos[3 * i + 2] - rz;
      ss.array[i] = this.smoke.size[i] * (1 + a * 0.15);
      sa.array[i] = Math.max(0, 0.5 * (1 - a / 90)) * Math.min(1, (60000 - alt) / 40000);
    }
    sp.needsUpdate = ss.needsUpdate = sa.needsUpdate = true;
    // pad (Earth-fixed): visible while low
    const padR = sim.padR;
    const c = Math.cos(theta), s = Math.sin(theta);
    const padI = [c * padR[0] - s * padR[1], s * padR[0] + c * padR[1], padR[2]];
    this.pad.visible = alt < 80000;
    this.pad.position.copy(toThree([padI[0] - r[0], padI[1] - r[1], padI[2] - r[2]]));
    this.pad.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toThree(padI).normalize());
    // spent stages near the vehicle
    for (const st of sim.spent) {
      let m = this.spentMeshes.get(st);
      const rel = [st.r[0] - r[0], st.r[1] - r[1], st.r[2] - r[2]];
      const d = Math.hypot(...rel);
      if (!m) {
        m = st.kind === 'fairing'
          ? new THREE.Mesh(new THREE.CylinderGeometry(st.diameter, st.diameter, st.length, 16, 1, true, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, side: THREE.DoubleSide }))
          : new THREE.Mesh(new THREE.CylinderGeometry(st.diameter / 2, st.diameter / 2, st.length, 20), new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.6 }));
        m.quaternion.copy(this.rocket.group.quaternion);
        this.lScene.add(m); this.spentMeshes.set(st, m);
      }
      m.visible = st.alive && d < 60000;
      m.position.copy(toThree(rel));
      m.rotateZ(st.spin * 0.004); m.rotateX(st.spin * 0.002);
    }
    // camera
    this._placeLocalCamera(sim, up);
  }

  _placeLocalCamera(sim, up) {
    const L = this.rocket.totalLength;
    const east = new THREE.Vector3(0, 1, 0).cross(up).normalize();
    if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
    const north = up.clone().cross(east).normalize();
    const cam = this.lCam;
    if (this.camMode === 'pad' && sim.environment(sim.r, sim.v).h < 60000) {
      const padR = sim.padR, th = sim.theta, c = Math.cos(th), s = Math.sin(th);
      const padI = [c * padR[0] - s * padR[1], s * padR[0] + c * padR[1], padR[2]];
      const padUp = toThree(padI).normalize();
      const padEast = new THREE.Vector3(0, 1, 0).cross(padUp).normalize();
      const camI = toThree(padI).add(padEast.multiplyScalar(-1800)).add(padUp.clone().multiplyScalar(25));
      cam.position.copy(camI.sub(toThree(sim.r)));
      cam.up.copy(padUp);
      cam.lookAt(0, L * 0.4, 0);
      const d = cam.position.length();
      cam.fov = Math.max(1.2, Math.min(55, 2 * Math.atan(L * 2.2 / d) * 180 / Math.PI));
      cam.updateProjectionMatrix();
      return;
    }
    if (cam.fov !== 55) { cam.fov = 55; cam.updateProjectionMatrix(); }
    const o = this.orbit;
    const d = L * 1.6 * o.dist;
    const dir = east.clone().multiplyScalar(Math.cos(o.pitch) * Math.cos(o.yaw)).add(north.clone().multiplyScalar(Math.cos(o.pitch) * Math.sin(o.yaw))).add(up.clone().multiplyScalar(Math.sin(o.pitch)));
    const axis = toThree(sim.att).normalize();
    const center = axis.clone().multiplyScalar(L * 0.35);
    if (this.camMode === 'onboard') {
      cam.position.copy(axis.clone().multiplyScalar(L * 0.9).add(east.clone().multiplyScalar(this.rocket.stageGroups[0].userData.radius * 1.4)));
      cam.up.copy(axis);
      cam.lookAt(axis.clone().multiplyScalar(-L));
      return;
    }
    cam.position.copy(center.clone().add(dir.multiplyScalar(d)));
    cam.up.copy(up);
    cam.lookAt(center);
  }

  /** Globe-view state: Earth rotation, sun, catalog time. */
  updateGlobe(date) {
    const th = gmst(julian(date));
    this.gEarth.rotation.y = th;
    this.gSun.position.copy(toThree(sunDirection(date)).multiplyScalar(100));
    if (this.cloud) this.cloud.setTime(date.getTime());
  }

  /** Shift the globe sideways (title screens) so it doesn't sit behind the menu. */
  setGlobeShift(frac) {
    const w = innerWidth, h = innerHeight;
    if (frac) this.gCam.setViewOffset(w, h, -w * frac, 0, w, h); else this.gCam.clearViewOffset();
  }

  render(dt) {
    this._dt = dt;
    if (this.mode === 'globe') { this.controls.update(); this.renderer.render(this.gScene, this.gCam); }
    else this.renderer.render(this.lScene, this.lCam);
  }
}
