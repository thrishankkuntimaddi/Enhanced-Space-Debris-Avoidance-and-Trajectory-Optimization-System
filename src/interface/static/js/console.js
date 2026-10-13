// SDATOS mission console: form -> /api/plan -> three.js scene + report panel.
// Frame: TEME (km). three.js is y-up, so TEME (x, y, z) -> scene (x, z, -y) / 1000.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const K = 1 / 1000;
const toV = (p) => new THREE.Vector3(p[0] * K, p[2] * K, -p[1] * K);
const RISK = { RED: 0xef4444, AMBER: 0xf59e0b, GREEN: 0x22c55e };
const TYPE_COLORS = [0x5eead4, 0xfbbf24, 0xf87171, 0x94a3b8];

// ── Scene ──────────────────────────────────────────────────────────────────
const host = $('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(14, 9, 16);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 7.2;
controls.maxDistance = 120;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(50, 20, 30);
scene.add(sun);

const RE = 6.378135;
const earth = new THREE.Mesh(
  new THREE.SphereGeometry(RE, 96, 64),
  new THREE.MeshPhongMaterial({ map: new THREE.TextureLoader().load('/static/images/earth_2048.jpg'), shininess: 8 })
);
scene.add(earth);
scene.add(new THREE.Mesh(new THREE.SphereGeometry(RE * 1.015, 64, 48),
  new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.08, side: THREE.BackSide })));

(function stars() {
  const n = 2500, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(300 + Math.random() * 200);
    a.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899aa, size: 0.6, sizeAttenuation: true })));
})();

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);

// ── Mission layer ──────────────────────────────────────────────────────────
let layer = new THREE.Group();
scene.add(layer);
let viz = null, cloud = null, cloudPos = null, rocket = null, trail = null;
let t = 0, tMin = 0, tMax = 1, playing = false;

function line(points, color, opts = {}) {
  const g = new THREE.BufferGeometry().setFromPoints(points.map(toV));
  const m = opts.dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: opts.opacity ?? 1 })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity: opts.opacity ?? 1 });
  const l = new THREE.Line(g, m);
  if (opts.dashed) l.computeLineDistances();
  return l;
}

function interp(points, tau, t0, dt) {
  const x = (tau - t0) / dt;
  if (x <= 0) return points[0];
  if (x >= points.length - 1) return points[points.length - 1];
  const i = Math.floor(x), f = x - i, a = points[i], b = points[i + 1];
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

function marker(p, color, size = 0.09) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), new THREE.MeshBasicMaterial({ color }));
  m.position.copy(toV(p));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(size * 2.6, 16, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18 }));
  m.add(halo);
  return m;
}

function loadViz(report) {
  scene.remove(layer);
  layer = new THREE.Group();
  scene.add(layer);
  viz = report.viz;
  const dtau = viz.tau[1] - viz.tau[0];
  const slip = viz.final_slip_s;
  const changed = JSON.stringify(viz.nominal) !== JSON.stringify(viz.final);

  if (changed) layer.add(line(viz.nominal, 0xfb923c, { dashed: true, opacity: 0.9 }));
  layer.add(line(viz.final, 0x22d3ee));

  // conjunction markers at TCA on the relevant trajectory
  for (const c of report.nominal.conjunctions) {
    if (c.risk === 'GREEN') continue;
    layer.add(marker(interp(viz.nominal, c.tca_mission_s, 0, dtau), RISK[c.risk]));
  }
  for (const c of report.final.conjunctions.slice(0, 6)) {
    if (c.risk === 'GREEN' && c.miss_km > 10) continue;
    layer.add(marker(interp(viz.final, c.tca_mission_s, 0, dtau), RISK[c.risk], 0.06));
  }
  // threat object tracks
  // only the objects that matter: RED/AMBER, plus the 3 closest otherwise
  const tracks = Object.values(viz.tracks);
  const shown = tracks.filter((tr) => tr.risk !== 'GREEN');
  for (const tr of (shown.length ? shown : tracks.slice(0, 3))) {
    layer.add(line(tr.pos, RISK[tr.risk] ?? 0x94a3b8, { opacity: 0.8 }));
  }

  // moving catalog cloud
  const raw = Uint8Array.from(atob(viz.cloud.pos_b64), (c) => c.charCodeAt(0));
  cloudPos = new Float32Array(raw.buffer);
  const n = viz.cloud.n;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const col = new Float32Array(n * 3);
  viz.cloud.types.forEach((ty, i) => { const c = new THREE.Color(TYPE_COLORS[ty]); col.set([c.r, c.g, c.b], i * 3); });
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  cloud = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.075, vertexColors: true, transparent: true, opacity: 0.95 }));
  layer.add(cloud);

  rocket = marker(viz.final[0], 0xffffff, 0.07);
  layer.add(rocket);

  tMin = Math.min(0, slip);
  tMax = viz.tau[viz.tau.length - 1] + Math.max(0, slip);
  t = tMin;
  update();
}

function update() {
  if (!viz) return;
  const slip = viz.final_slip_s;
  const dtau = viz.tau[1] - viz.tau[0];
  earth.rotation.y = viz.gmst0_rad + viz.omega_earth * t;

  const tau = t - slip;
  rocket.visible = tau >= 0;
  if (tau >= 0) rocket.position.copy(toV(interp(viz.final, tau, 0, dtau)));

  // catalog cloud (linear interpolation between 60 s samples)
  const { n, steps, dt } = viz.cloud;
  const x = Math.max(0, Math.min(steps - 1.0001, t / dt));
  const i = Math.floor(x), f = x - i;
  const arr = cloud.geometry.attributes.position.array;
  const a = i * n * 3, b = (i + 1) * n * 3;
  for (let k = 0; k < n; k++) {
    const j = k * 3;
    const px = cloudPos[a + j] + f * (cloudPos[b + j] - cloudPos[a + j]);
    const py = cloudPos[a + j + 1] + f * (cloudPos[b + j + 1] - cloudPos[a + j + 1]);
    const pz = cloudPos[a + j + 2] + f * (cloudPos[b + j + 2] - cloudPos[a + j + 2]);
    arr[j] = px * K; arr[j + 1] = pz * K; arr[j + 2] = -py * K;
  }
  cloud.geometry.attributes.position.needsUpdate = true;

  const utc = new Date(Date.parse(lastReport.mission.nominal_launch_utc.replace(' ', 'T') + 'Z') + t * 1000);
  const phase = tau < 0 ? 'pre-launch' : tau < viz.ascent_s ? 'ascent' : 'orbit';
  $('clock').textContent = `${utc.toISOString().replace('T', ' ').slice(0, 19)} UTC · T${tau >= 0 ? '+' : '−'}${fmtDur(Math.abs(tau))} · ${phase}`;
  $('scrub').value = Math.round(1000 * (t - tMin) / (tMax - tMin));
  if ($('follow').checked && rocket.visible) controls.target.lerp(rocket.position, 0.1);
}

function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

let last = performance.now();
function animate(now) {
  const dt = (now - last) / 1000;
  last = now;
  if (playing && viz) {
    t += dt * Number($('speed').value);
    if (t > tMax) t = tMin;
    update();
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

$('play').onclick = () => { playing = !playing; $('play').textContent = playing ? '❚❚' : '▶'; };
$('scrub').oninput = (e) => { t = tMin + (tMax - tMin) * e.target.value / 1000; update(); };
$('follow').onchange = (e) => { if (!e.target.checked) controls.target.set(0, 0, 0); };

// ── Form & report ─────────────────────────────────────────────────────────
let meta = null, lastReport = null;

async function init() {
  meta = await (await fetch('/api/meta')).json();
  const sel = $('rocket');
  for (const r of meta.rockets) {
    const o = document.createElement('option');
    o.value = r.name; o.textContent = `${r.name}`;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    const r = meta.rockets.find((x) => x.name === sel.value);
    $('site').textContent = `${r.site} · ${r.lat.toFixed(2)}°, ${r.lon.toFixed(2)}° · min inclination ${Math.abs(r.lat).toFixed(1)}°`;
  };
  sel.value = 'Falcon 9'; sel.onchange();
  $('launch').min = meta.window.min; $('launch').max = meta.window.max;
  $('launch').value = '2025-03-12T06:00';
  $('window').textContent = `TLE validity window: ${meta.window.min.replace('T', ' ')} → ${meta.window.max.replace('T', ' ')} UTC`;
  $('threats').oninput = (e) => { $('thr-v').textContent = e.target.value; };
  const q = meta.quality;
  if (q) {
    $('provenance').innerHTML = `<div><b>${q.unique_objects.toLocaleString()}</b> tracked objects · <b>${q.elsets_in_history.toLocaleString()}</b> elsets</div>
      <div>${q.window_days}-day window ending <b>${q.reference_epoch.slice(0, 16).replace('T', ' ')}</b> UTC</div>
      <div>source: ${q.sources.join(', ')}</div>`;
  }
  const presets = [
    { label: 'Real catalog · Falcon 9 → 550 km (Starlink shell)', rocket: 'Falcon 9', alt: 550, launch: '2025-03-12T06:00', threats: 0, slip: 600 },
    { label: 'Real catalog · PSLV → 700 km SSO 97.5°', rocket: 'PSLV', alt: 700, inc: 97.5, launch: '2025-03-11T04:30', threats: 0, slip: 300 },
    { label: 'Stress test · Electron 500 km, 3 threat events', rocket: 'Electron', alt: 500, launch: '2025-03-12T09:00', threats: 3, slip: 600, seed: 4 },
    { label: 'Stress test · instantaneous window, 4 events', rocket: 'Vega', alt: 600, launch: '2025-03-11T18:00', threats: 4, slip: 0, seed: 7 },
  ];
  for (const p of presets) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = p.label;
    b.onclick = () => {
      $('rocket').value = p.rocket; $('rocket').onchange();
      $('alt').value = p.alt; $('inc').value = p.inc ?? ''; $('launch').value = p.launch;
      $('threats').value = p.threats; $('thr-v').textContent = p.threats;
      $('slip').value = p.slip; $('seed').value = p.seed ?? 0;
      $('mission-form').requestSubmit();
    };
    $('preset-list').appendChild(b);
  }
}

$('mission-form').onsubmit = async (e) => {
  e.preventDefault();
  $('go').disabled = true;
  $('busy').classList.remove('hidden');
  $('busy-msg').textContent = 'Propagating catalog & screening conjunctions…';
  try {
    const res = await fetch('/api/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rocket: $('rocket').value, target_alt_km: $('alt').value, inclination_deg: $('inc').value,
        launch_time: $('launch').value, synthetic_threats: $('threats').value,
        slip_allowed_s: $('slip').value, seed: $('seed').value,
      }),
    });
    const rep = await res.json();
    if (!res.ok) throw new Error(rep.error || res.statusText);
    lastReport = rep;
    renderReport(rep);
    loadViz(rep);
    playing = true; $('play').textContent = '❚❚';
  } catch (err) {
    $('results').innerHTML = `<h2>Report</h2><div class="error">${escapeHtml(err.message)}</div>`;
  } finally {
    $('go').disabled = false;
    $('busy').classList.add('hidden');
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmtPc = (p) => (p < 1e-12 ? '<1e-12' : p.toExponential(1));

function conjTable(rows) {
  if (!rows.length) return '<p class="muted small">No objects within 25 km.</p>';
  return `<table><tr><th>Object</th><th class="num">Miss km</th><th class="num">Pc</th><th class="num">TCA (T+)</th><th></th></tr>
    ${rows.slice(0, 8).map((c) => `<tr><td title="${escapeHtml(c.type)} · ${c.object_id}">${escapeHtml(c.name)}</td>
      <td class="num">${c.miss_km.toFixed(2)}</td><td class="num">${fmtPc(c.pc)}</td>
      <td class="num">${fmtDur(c.tca_mission_s)}</td><td><span class="pill ${c.risk}">${c.risk}</span></td></tr>`).join('')}</table>`;
}

function renderReport(r) {
  const cls = r.verdict === 'GO' ? 'go' : r.verdict.startsWith('GO') ? 'avoid' : 'nogo';
  const p = r.decision.plan, s = r.screening;
  const trace = r.decision.trace.map((x) => `<li><span>${x.step}. ${escapeHtml(x.action)}</span>
      <span class="muted">slip ${x.slip_s >= 0 ? '+' : ''}${x.slip_s}s · Δh ${x.dalt_km}km · Δv ${x.dv_ms}m/s · R${x.red}/A${x.amber}</span></li>`).join('');
  $('results').innerHTML = `
    <h2>Report</h2>
    <div class="verdict ${cls}">${escapeHtml(r.verdict)}</div>
    <div class="kpis">
      <div class="kpi"><div class="v">${r.nominal.red}/${r.nominal.amber}</div><div class="l">RED/AMBER nominal</div></div>
      <div class="kpi"><div class="v">${r.final.red}/${r.final.amber}</div><div class="l">RED/AMBER planned</div></div>
      <div class="kpi"><div class="v">${r.final.min_miss_km.toFixed(2)}</div><div class="l">min miss km</div></div>
      <div class="kpi"><div class="v">${p.dv_cost_ms.toFixed(2)}</div><div class="l">extra Δv m/s</div></div>
      <div class="kpi"><div class="v">${p.slip_s >= 0 ? '+' : ''}${p.slip_s / 60}</div><div class="l">launch slip min</div></div>
      <div class="kpi"><div class="v">${r.decision.screen_calls}</div><div class="l">screenings used</div></div>
    </div>
    <h3>Decision · ${escapeHtml(r.decision.policy)}${r.decision.fallback_used ? ' <span class="pill AMBER">fallback</span>' : ''}</h3>
    ${trace ? `<ul class="trace">${trace}</ul>` : '<p class="muted small">Nominal plan already clear, no maneuver.</p>'}
    <p class="small">Planned launch <b>${p.launch_utc}</b> UTC · insertion ${r.mission.target_alt_km + p.dalt_km} km · phasing ${p.dv_ms} m/s</p>
    <h3>Conjunctions · nominal</h3>${conjTable(r.nominal.conjunctions)}
    <h3>Conjunctions · planned</h3>${conjTable(r.final.conjunctions)}
    <h3>Screening funnel</h3>
    <div class="funnel">catalog <b>${s.catalog_objects.toLocaleString()}</b> → altitude filter <b>${s.after_altitude_filter.toLocaleString()}</b>
      → proximity prune <b>${s.after_proximity_prune.toLocaleString()}</b>${s.synthetic_objects ? ` + <b>${s.synthetic_objects}</b> synthetic` : ''}<br>
      context ${r.timings.screening_context_s}s · per-plan screen ${r.timings.nominal_screen_ms.toFixed(0)} ms${r.timings.optimizer_s !== undefined ? ` · optimizer ${r.timings.optimizer_s}s` : ''}</div>
    <h3>Mission</h3>
    <div class="small muted">${escapeHtml(r.mission.rocket)} · ${escapeHtml(r.mission.launch_site)} · inc ${r.mission.inclination_deg}° · az ${r.mission.launch_azimuth_deg}° · ascent ${r.mission.ascent_s}s</div>
    <p><a href="/report/${r.id}" target="_blank">Open full mission report ↗</a> · <a href="/api/report/${r.id}" target="_blank">JSON</a></p>`;
}

init();
