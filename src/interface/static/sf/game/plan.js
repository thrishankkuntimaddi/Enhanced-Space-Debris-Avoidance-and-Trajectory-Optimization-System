// Mission planning: catalog, SGP4 worker pool, the vehicle's predicted path, and the screening
// context that every "what if" (launch slip, insertion altitude, phasing burn, in-orbit burn)
// is evaluated against. Same coarse-to-fine design as the Python screener, including the
// maneuver-envelope prune margin (so no object an allowed plan could meet is dropped).
import { FlightSim, optimizeAscent } from '../physics/flight.js';
import { propagate, elements } from '../physics/orbit.js';
import { norm, unit } from '../physics/frames.js';
import { OMEGA_E, DALT_MAX_KM, DV_MAX_MS, REPORT_KM } from '../physics/constants.js';
import { Ephemeris, Path, screen, summarize, conjunctions, sigmaForAge } from '../physics/collision.js';
import { MU_KM } from '../physics/constants.js';

const GRID_DT = 60;

// ── catalog ─────────────────────────────────────────────────────────────────
let catalogPromise = null;
export function loadCatalog() {
  if (!catalogPromise) catalogPromise = fetch('/api/catalog').then((r) => { if (!r.ok) throw new Error('catalog ' + r.status); return r.json(); });
  return catalogPromise;
}

// ── worker pool ─────────────────────────────────────────────────────────────
function runWorkers(rows, job, onProgress) {
  const nW = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  const chunk = Math.ceil(rows.length / nW);
  const progress = new Array(nW).fill(0);
  return Promise.all(Array.from({ length: nW }, (_, w) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/sgp4.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      if (ev.data.done) { worker.terminate(); resolve(ev.data); return; }
      progress[w] = ev.data.progress;
      onProgress?.(progress.reduce((a, b) => a + b, 0) / nW);
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'SGP4 worker failed')); };
    worker.postMessage({ ...job, rows: rows.slice(w * chunk, (w + 1) * chunk) });
  })));
}

// ── vehicle paths ───────────────────────────────────────────────────────────
/** Fly the ascent once, recording the state. Returns { sim, samples: [{t, r, v}] } in SI. */
export function flyRecorded(cfg, dt = 0.1, every = 4) {
  const sim = new FlightSim(cfg);
  const samples = [];
  let next = 0;
  sim.liftoff();
  while (sim.t < 9000 && sim.phase !== 'ORBIT' && sim.phase !== 'FAILED') {
    sim.advance(0.5, dt);
    const coast = sim.phase === 'COAST';
    if (sim.t >= next) { samples.push({ t: sim.t, r: sim.r.slice(), v: sim.v.slice() }); next = sim.t + (coast ? 30 : every); }
  }
  samples.push({ t: sim.t, r: sim.r.slice(), v: sim.v.slice() });
  return { sim, samples };
}

/** Build a screening Path (km, seconds after the ephemeris epoch) from flight samples followed
 *  by a coast to `endT` (s after liftoff), optionally with an along-track burn dv (m/s) at the
 *  first coast sample (the phasing burn at insertion). */
export function buildPath(samples, endT, offset, dvAlong = 0) {
  const last = samples[samples.length - 1];
  let v0 = last.v;
  if (dvAlong) v0 = v0.map((x, i) => x + dvAlong * unit(last.v)[i]);
  const tail = endT > last.t ? propagate(last.r, v0, endT - last.t, 30, 10) : { t: [0], r: last.r, v: v0 };
  const n = samples.length - 1 + tail.t.length;
  const t = new Float64Array(n), r = new Float64Array(3 * n), v = new Float64Array(3 * n);
  let k = 0;
  for (let i = 0; i < samples.length - 1; i++, k++) {
    t[k] = samples[i].t + offset;
    for (let c = 0; c < 3; c++) { r[3 * k + c] = samples[i].r[c] / 1000; v[3 * k + c] = samples[i].v[c] / 1000; }
  }
  for (let i = 0; i < tail.t.length; i++, k++) {
    t[k] = last.t + tail.t[i] + offset;
    for (let c = 0; c < 3; c++) { r[3 * k + c] = tail.r[3 * i + c] / 1000; v[3 * k + c] = tail.v[3 * i + c] / 1000; }
  }
  return new Path(t, r, v);
}

/** Path sampled exactly on grid times (for the worker prune), for one slip. */
function gridSamples(path, slip, slipMax, steps) {
  const k0 = Math.round((slipMax + slip) / GRID_DT);
  const m = Math.min(steps - k0, Math.ceil((path.t[path.n - 1] - path.t[0]) / GRID_DT) + 1);
  const r = new Float64Array(3 * m), st = new Float64Array(6);
  const c = Math.cos(OMEGA_E * slip), s = Math.sin(OMEGA_E * slip);
  for (let j = 0; j < m; j++) {
    path.state(path.t[0] + j * GRID_DT, st);
    r[3 * j] = c * st[0] - s * st[1]; r[3 * j + 1] = s * st[0] + c * st[1]; r[3 * j + 2] = st[2];
  }
  return { k0, r, m };
}

function maxDeviation(a, b) {
  let d = 0;
  const sa = new Float64Array(6), sb = new Float64Array(6);
  for (let t = a.t[0]; t <= Math.min(a.t[a.n - 1], b.t[b.n - 1]); t += 30) {
    a.state(t, sa); b.state(t, sb);
    d = Math.max(d, Math.hypot(sa[0] - sb[0], sa[1] - sb[1], sa[2] - sb[2]));
  }
  return d;
}

// ── the mission plan ────────────────────────────────────────────────────────
export class MissionPlan {
  /** cfg: { vehicle, site, payloadKg, targetAltKm, targetIncDeg, launchDate, slipMax (s), orbitsAfter } */
  constructor(cfg) {
    this.cfg = { orbitsAfter: 1.5, slipMax: 600, ...cfg };
    this.slipMax = this.cfg.slipMax;
    this.flights = new Map();    // dalt -> recorded flight
  }

  flightFor(dalt) {
    const key = dalt.toFixed(1);
    if (!this.flights.has(key)) {
      this.flights.set(key, flyRecorded({ ...this.flightCfg, targetAltKm: this.cfg.targetAltKm + dalt }));
    }
    return this.flights.get(key);
  }

  get flightCfg() {
    const c = this.cfg;
    return { vehicle: c.vehicle, site: c.site, payloadKg: c.payloadKg, targetAltKm: c.targetAltKm, targetIncDeg: c.targetIncDeg,
      launchDate: c.launchDate, kickDeg: this.kickDeg, guidanceBiasKm: this.guidanceBiasKm || 0, branch: c.branch };
  }

  /** Path for a plan {slip, dalt, dv} in the ephemeris time base. */
  pathFor(plan) {
    const f = this.flightFor(plan.dalt);
    const base = buildPath(f.samples, this.horizon, this.slipMax, plan.dv);
    return plan.slip ? base.slipped(plan.slip) : base;
  }

  /** 1) flight computer  2) nominal + envelope  3) SGP4 the catalog in workers and prune. */
  async prepare(onStatus = () => {}) {
    const c = this.cfg;
    onStatus('Flight computer: optimising the ascent profile', 0.02);
    await tick();
    const opt = optimizeAscent({ vehicle: c.vehicle, site: c.site, payloadKg: c.payloadKg, targetAltKm: c.targetAltKm,
      targetIncDeg: c.targetIncDeg, launchDate: c.launchDate, branch: c.branch });
    this.ascent = opt;
    this.kickDeg = opt.kickDeg;
    this.guidanceBiasKm = opt.guidanceBiasKm;
    if (!opt.ok) { this.error = opt.sim.failure; return this; }
    onStatus('Predicting the trajectory and the maneuver envelope', 0.12);
    await tick();
    const nominal = this.flightFor(0);
    const el = nominal.sim.insertion.el;
    this.insertionT = nominal.sim.insertion.t;
    this.period = el.period;
    this.horizon = this.insertionT + c.orbitsAfter * el.period;
    this.duration = this.horizon;
    const nomPath = this.pathFor({ slip: 0, dalt: 0, dv: 0 });
    let env = 0;
    for (const dalt of [-DALT_MAX_KM, 0, DALT_MAX_KM]) for (const dv of [-DV_MAX_MS, 0, DV_MAX_MS]) {
      if (!dalt && !dv) continue;
      env = Math.max(env, maxDeviation(nomPath, this.pathFor({ slip: 0, dalt, dv })));
      await tick();
    }
    this.envelopeKm = env;
    this.keepKm = env + REPORT_KM + 20;   // +20 km: the coarse prune samples the powered ascent every 60 s

    onStatus('Downloading the catalog', 0.2);
    const cat = await loadCatalog();
    this.catalogMeta = cat.meta;
    const maxAlt = c.targetAltKm + DALT_MAX_KM + 60;
    const rows = cat.rows.filter((r) => r[5] <= maxAlt && r[6] >= 80);
    this.stats = { catalog: cat.rows.length, band: rows.length };

    const steps = Math.ceil((2 * this.slipMax + this.horizon) / GRID_DT) + 2;
    this.epochMs = c.launchDate.getTime() - this.slipMax * 1000;
    const slips = [];
    for (let s = -this.slipMax; s <= this.slipMax + 1e-9; s += GRID_DT) slips.push(s);
    const paths = slips.map((s) => gridSamples(nomPath, s, this.slipMax, steps));
    onStatus(`SGP4: propagating ${rows.length.toLocaleString()} objects`, 0.25);
    const t0 = performance.now();
    const parts = await runWorkers(rows, { epochMs: this.epochMs, dt: GRID_DT, steps, paths, keepKm: this.keepKm, launchMs: c.launchDate.getTime() },
      (p) => onStatus(`SGP4: propagating ${rows.length.toLocaleString()} objects`, 0.25 + 0.7 * p));
    this.eph = Ephemeris.fromParts(parts.filter((p) => p.n > 0).length ? parts.filter((p) => p.n > 0) : [parts[0]]);
    this.stats.kept = this.eph.n;
    this.stats.sgp4Ms = performance.now() - t0;
    this.stats.keepKm = this.keepKm;
    this.stats.envelopeKm = env;
    onStatus('Screening the nominal plan', 0.97);
    await tick();
    this.nominal = this.screenPlan({ slip: 0, dalt: 0, dv: 0 });
    onStatus('Ready', 1);
    return this;
  }

  /** Screen a plan. Returns the raw result with mission-relative times (tau) for the AI. */
  screenPlan(plan) {
    const path = this.pathFor(plan);
    const res = screen(this.eph, path);
    res.tau = Float64Array.from(res.tca, (t) => t - (this.slipMax + plan.slip));
    res.plan = plan; res.path = path;
    res.summary = summarize(res);
    return res;
  }

  conj(res) { return conjunctions(this.eph, res); }

  /** The scenario interface the Sentinel AI expects. */
  scenario(slipAllowed) {
    return { slipMax: this.slipMax, slipAllowed, duration: this.duration, targetAltKm: this.cfg.targetAltKm,
      screen: (p) => this.screenPlan(p) };
  }

  /** Launch-COLA blackout curve: min miss and max Pc for every launch time in the window. */
  blackout(step = 60) {
    const out = [];
    for (let s = -this.slipMax; s <= this.slipMax + 1e-9; s += step) {
      const r = this.screenPlan({ slip: s, dalt: 0, dv: 0 });
      out.push({ slip: s, ...r.summary });
    }
    return out;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── synthetic threats (port of src/rl/scenarios.py make_threats) ────────────
export function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  const next = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  next.uniform = (lo, hi) => lo + (hi - lo) * next();
  next.normal = (mu = 0, sd = 1) => mu + sd * Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo));
  return next;
}

/** Add fragment clouds / single crossings that intersect `path` between times tA and tB
 *  (seconds after the ephemeris epoch). Each fragment flies a two-body circular orbit through a
 *  point near the path, crossing it at an angle: a physically valid orbit, not a scripted dot. */
export function injectThreats(eph, path, R, nEvents, { tA, tB, cloudProb = 0.5, parent = 'UNKNOWN OBJECT', idStart = -1 } = {}) {
  const add = [];
  const st = new Float64Array(6);
  let id = idStart;
  for (let ev = 0; ev < nEvents; ev++) {
    const tc = R.uniform(tA, tB);
    path.state(tc, st);
    const p = [st[0], st[1], st[2]], v = [st[3], st[4], st[5]];
    const rn = Math.hypot(...p), rh = p.map((x) => x / rn);
    const h = [p[1] * v[2] - p[2] * v[1], p[2] * v[0] - p[0] * v[2], p[0] * v[1] - p[1] * v[0]];
    const hn = Math.hypot(...h), nh = h.map((x) => x / hn);
    const th = [nh[1] * rh[2] - nh[2] * rh[1], nh[2] * rh[0] - nh[0] * rh[2], nh[0] * rh[1] - nh[1] * rh[0]];
    const alpha = R.uniform(15, 170) * Math.PI / 180;
    const cloud = R() < cloudProb;
    const nFrag = cloud ? R.int(4, 9) : 1;
    for (let f = 0; f < nFrag; f++) {
      const off = [R.normal(0, 0.3), R.uniform(-0.9, 0.9), R.uniform(-0.9, 0.9)];
      if (cloud) { off[0] += R.normal(0, 1.5); off[1] += R.normal(0, 4); off[2] += R.normal(0, 2); }
      const dtShift = cloud ? R.uniform(-60, 60) : 0;
      const a = alpha + (cloud ? R.normal(0, 3) * Math.PI / 180 : 0);
      const p0 = [0, 1, 2].map((c) => p[c] + off[0] * rh[c] + off[1] * th[c] + off[2] * nh[c]);
      const r0 = Math.hypot(...p0), e1 = p0.map((x) => x / r0);
      let vh = [0, 1, 2].map((c) => Math.cos(a) * th[c] + Math.sin(a) * nh[c]);
      const dp = vh[0] * e1[0] + vh[1] * e1[1] + vh[2] * e1[2];
      vh = vh.map((x, c) => x - dp * e1[c]);
      const vn = Math.hypot(...vh); vh = vh.map((x) => x / vn);
      const w = Math.sqrt(MU_KM / r0 ** 3);
      add.push({ e1, vh, r0, w, t0: tc + dtShift,
        meta: { id: id--, name: `${parent} DEB ${ev + 1}${cloud ? String.fromCharCode(65 + f) : ''}`, type: 'FRAGMENT', owner: '',
          hbr: 0.010, sigma: sigmaForAge(R.uniform(0.2, 3.0)), synthetic: true } });
    }
  }
  if (!add.length) return eph;
  const out = new Ephemeris({ epochMs: eph.epochMs, dt: eph.dt, steps: eph.steps, n: eph.n + add.length });
  out.pos.set(eph.pos); out.vel.set(eph.vel); out.ok.set(eph.ok); out.meta = [...eph.meta];
  add.forEach((o, q) => {
    const i = eph.n + q;
    for (let k = 0; k < eph.steps; k++) {
      const t = k * eph.dt - o.t0, c = Math.cos(o.w * t), s = Math.sin(o.w * t), b = (i * eph.steps + k) * 3;
      for (let j = 0; j < 3; j++) {
        out.pos[b + j] = o.r0 * (c * o.e1[j] + s * o.vh[j]);
        out.vel[b + j] = o.r0 * o.w * (-s * o.e1[j] + c * o.vh[j]);
      }
      out.ok[i * eph.steps + k] = 1;
    }
    out.meta.push(o.meta);
  });
  return out;
}
