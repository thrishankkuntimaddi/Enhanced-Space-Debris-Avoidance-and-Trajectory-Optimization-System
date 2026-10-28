// Conjunction screening in the browser (km, s). Mirrors src/screening/conjunction.py:
//   catalog ephemeris on a uniform grid (SGP4 position AND velocity every `dt` seconds),
//   cubic Hermite interpolation between samples (error well under a metre at 60 s spacing,
//   because the 4th derivative of orbital motion is tiny),
//   closest approach per segment of the vehicle's path in closed form (relative motion of two
//   free-falling bodies is almost exactly linear over a minute: the gravity-gradient term
//   bends it by < 0.1 % of the separation), then refined on the exact Hermite curves,
//   and collision probability with the 2-D Gaussian encounter-plane model.
import { PC_RED, PC_AMBER, MISS_RED_KM, MISS_AMBER_KM, MISSION_SIGMA_KM, SIGMA0_KM, SIGMA_K_KM_PER_DAY, OMEGA_E, RE_KM } from './constants.js';

// ── probability of collision ────────────────────────────────────────────────
const LOGFACT = (() => { const a = new Float64Array(171); for (let i = 2; i < 171; i++) a[i] = a[i - 1] + Math.log(i); return a; })();
function logGammaInt(n) {   // log((n-1)!): table, then Stirling's series (error < 1e-10 beyond 170)
  const m = n - 1;
  if (m < 171) return LOGFACT[m];
  return m * Math.log(m) - m + 0.5 * Math.log(2 * Math.PI * m) + 1 / (12 * m) - 1 / (360 * m ** 3);
}

/** P(chi'^2 with 2 dof and non-centrality lam <= x): Poisson mixture of central chi-squares.
 *  Equals scipy.stats.ncx2.cdf(x, 2, lam). */
export function ncx2cdf2(x, lam) {
  if (x <= 0) return 0;
  const half = lam / 2, xh = x / 2;
  const jMax = Math.ceil(half + 12 * Math.sqrt(half + 1) + 30);
  let total = 0;
  // P(chi^2_{2k} <= x) = regularized lower gamma P(k, x/2), via its series
  for (let j = 0; j <= jMax; j++) {
    const logW = -half + (j > 0 ? j * Math.log(half) - logGammaInt(j + 1) : 0);
    if (logW < -745) { if (j > half) break; else continue; }
    const k = j + 1;
    // P(k, xh) = exp(-xh) * sum_{i>=k} xh^i / i!
    let term = Math.exp(-xh + k * Math.log(xh) - logGammaInt(k + 1)), sum = term;
    for (let i = k + 1; i < k + 400 && term > 1e-18 * sum; i++) { term *= xh / i; sum += term; }
    const contrib = Math.exp(logW) * sum;
    total += contrib;
    if (j > half && contrib < 1e-18) break;
  }
  return Math.min(1, total);
}

export function collisionProbability(missKm, sigmaKm, hbrKm) {
  if (!Number.isFinite(missKm)) return 0;
  // beyond 40 sigma the probability is below 1e-300: zero in double precision (scipy agrees)
  if (missKm - hbrKm > 40 * sigmaKm) return 0;
  return ncx2cdf2((hbrKm / sigmaKm) ** 2, (missKm / sigmaKm) ** 2);
}

export function riskLevel(pc, missKm) {
  if (pc >= PC_RED || missKm < MISS_RED_KM) return 'RED';
  if (pc >= PC_AMBER || missKm < MISS_AMBER_KM) return 'AMBER';
  return 'GREEN';
}

export const sigmaForAge = (ageDays) => SIGMA0_KM + SIGMA_K_KM_PER_DAY * Math.max(0, ageDays);

// ── ephemeris store ─────────────────────────────────────────────────────────
/** Objects sampled on a common grid: t_k = k * dt seconds after `epochMs`. */
export class Ephemeris {
  constructor({ epochMs, dt, steps, n }) {
    Object.assign(this, { epochMs, dt, steps, n });
    this.pos = new Float32Array(n * steps * 3);
    this.vel = new Float32Array(n * steps * 3);
    this.ok = new Uint8Array(n * steps);
    this.meta = [];      // per object: { id, name, type, owner, sigma, hbr }
  }
  static fromParts(parts) {   // concatenate worker outputs that share a grid
    const n = parts.reduce((a, p) => a + p.n, 0);
    const e = new Ephemeris({ epochMs: parts[0].epochMs, dt: parts[0].dt, steps: parts[0].steps, n });
    let o = 0;
    for (const p of parts) {
      e.pos.set(p.pos, o * p.steps * 3); e.vel.set(p.vel, o * p.steps * 3); e.ok.set(p.ok, o * p.steps);
      e.meta.push(...p.meta); o += p.n;
    }
    return e;
  }
  /** Position (km) and velocity (km/s) of object i at t seconds after epoch (cubic Hermite). */
  state(i, t, out = new Float64Array(6)) {
    const x = t / this.dt;
    let k = Math.floor(x);
    if (k < 0 || k >= this.steps - 1) { out.fill(NaN); return out; }
    const b = (i * this.steps + k), b3 = b * 3;
    if (!this.ok[b] || !this.ok[b + 1]) { out.fill(NaN); return out; }
    const s = x - k, h = this.dt;
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / h, d11 = 3 * s2 - 2 * s;
    const P = this.pos, V = this.vel;
    for (let c = 0; c < 3; c++) {
      const p0 = P[b3 + c], p1 = P[b3 + 3 + c], v0 = V[b3 + c], v1 = V[b3 + 3 + c];
      out[c] = h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
      out[3 + c] = d00 * p0 + d10 * v0 + d01 * p1 + d11 * v1;
    }
    return out;
  }
}

// ── vehicle path ────────────────────────────────────────────────────────────
/** A vehicle trajectory: times (s after the ephemeris epoch), positions (km), velocities (km/s). */
export class Path {
  constructor(t, r, v) { this.t = t; this.r = r; this.v = v; this.n = t.length; }
  /** The same flight launched `slip` seconds later: shifted in time and rotated with the Earth
   *  (the launch site moves through inertial space at exactly Earth's rotation rate). */
  slipped(slip) {
    const c = Math.cos(OMEGA_E * slip), s = Math.sin(OMEGA_E * slip);
    const t = new Float64Array(this.n), r = new Float64Array(3 * this.n), v = new Float64Array(3 * this.n);
    for (let i = 0; i < this.n; i++) {
      t[i] = this.t[i] + slip;
      const x = this.r[3 * i], y = this.r[3 * i + 1], vx = this.v[3 * i], vy = this.v[3 * i + 1];
      r[3 * i] = c * x - s * y; r[3 * i + 1] = s * x + c * y; r[3 * i + 2] = this.r[3 * i + 2];
      v[3 * i] = c * vx - s * vy; v[3 * i + 1] = s * vx + c * vy; v[3 * i + 2] = this.v[3 * i + 2];
    }
    return new Path(t, r, v);
  }
  state(t, out = new Float64Array(6)) {   // Hermite on the vehicle's own samples
    let lo = 0, hi = this.n - 1;
    if (t <= this.t[0] || t >= this.t[hi]) { const k = t <= this.t[0] ? 0 : hi; for (let c = 0; c < 3; c++) { out[c] = this.r[3 * k + c]; out[3 + c] = this.v[3 * k + c]; } return out; }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.t[m] <= t) lo = m; else hi = m; }
    const h = this.t[hi] - this.t[lo], s = (t - this.t[lo]) / h, s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / h, d11 = 3 * s2 - 2 * s;
    for (let c = 0; c < 3; c++) {
      const p0 = this.r[3 * lo + c], p1 = this.r[3 * hi + c], v0 = this.v[3 * lo + c], v1 = this.v[3 * hi + c];
      out[c] = h00 * p0 + h10 * h * v0 + h01 * p1 + h11 * h * v1;
      out[3 + c] = d00 * p0 + d10 * v0 + d01 * p1 + d11 * v1;
    }
    return out;
  }
}

const MIN_ALT_KM = 80;
const REFINE_KM = 60;
const COARSE_KM = 150;    // > max chord error of a 60 s powered-flight segment (~20 km) + reporting radius      // segments whose linear closest approach is below this get the exact solve

/** Closest approach of every object in `eph` to the vehicle flying `path`.
 *  Options: tMin (ignore encounters before this time), objects (subset of indices).
 *  Returns arrays: miss (km), tca (s after epoch), relSpeed (km/s), rtn (3n km), pc. */
export function screen(eph, path, { tMin = -Infinity, objects = null } = {}) {
  const idx = objects || Array.from({ length: eph.n }, (_, i) => i);
  const N = idx.length, M = path.n;
  const active = new Uint8Array(M);
  for (let j = 0; j < M; j++) {
    const x = path.r[3 * j], y = path.r[3 * j + 1], z = path.r[3 * j + 2];
    active[j] = Math.hypot(x, y, z) - RE_KM > MIN_ALT_KM && path.t[j] >= tMin ? 1 : 0;
  }
  const out = { miss: new Float64Array(N).fill(Infinity), tca: new Float64Array(N), relSpeed: new Float64Array(N),
    rtn: new Float64Array(3 * N), pc: new Float64Array(N), index: Int32Array.from(idx) };
  const D = new Float64Array(3 * M), ok = new Uint8Array(M), st = new Float64Array(6);
  // coarse pass on the ephemeris grid itself (no interpolation): the vehicle is evaluated once per
  // grid time, then each object needs only a linear closest approach per 60 s segment. Objects that
  // stay > COARSE_KM away (far beyond any reportable or non-zero-Pc distance) skip the fine pass.
  const k0 = Math.max(0, Math.ceil(Math.max(path.t[0], tMin) / eph.dt)), k1 = Math.min(eph.steps - 1, Math.floor(path.t[M - 1] / eph.dt));
  const G = Math.max(0, k1 - k0 + 1), VG = new Float64Array(3 * G), vok = new Uint8Array(G);
  for (let g = 0; g < G; g++) {
    path.state((k0 + g) * eph.dt, st);
    VG[3 * g] = st[0]; VG[3 * g + 1] = st[1]; VG[3 * g + 2] = st[2];
    vok[g] = Math.hypot(st[0], st[1], st[2]) - RE_KM > MIN_ALT_KM ? 1 : 0;
  }
  for (let q = 0; q < N; q++) {
    const i = idx[q];
    if (G > 1) {
      let coarse = Infinity;
      const base = i * eph.steps;
      for (let g = 0; g < G - 1; g++) {
        const k = k0 + g;
        if (!vok[g] || !vok[g + 1] || !eph.ok[base + k] || !eph.ok[base + k + 1]) continue;
        const o = (base + k) * 3;
        const ax = eph.pos[o] - VG[3 * g], ay = eph.pos[o + 1] - VG[3 * g + 1], az = eph.pos[o + 2] - VG[3 * g + 2];
        const bx = eph.pos[o + 3] - VG[3 * g + 3] - ax, by = eph.pos[o + 4] - VG[3 * g + 4] - ay, bz = eph.pos[o + 5] - VG[3 * g + 5] - az;
        const bb = bx * bx + by * by + bz * bz;
        let s = bb > 1e-12 ? -(ax * bx + ay * by + az * bz) / bb : 0;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
        const m = Math.hypot(ax + s * bx, ay + s * by, az + s * bz);
        if (m < coarse) coarse = m;
      }
      if (coarse > COARSE_KM) { out.miss[q] = coarse; continue; }
    }
    for (let j = 0; j < M; j++) {
      eph.state(i, path.t[j], st);
      ok[j] = active[j] && Number.isFinite(st[0]) ? 1 : 0;
      D[3 * j] = st[0] - path.r[3 * j]; D[3 * j + 1] = st[1] - path.r[3 * j + 1]; D[3 * j + 2] = st[2] - path.r[3 * j + 2];
    }
    let best = Infinity, bestJ = -1, bestS = 0;
    for (let j = 0; j < M - 1; j++) {
      if (!ok[j] || !ok[j + 1]) continue;
      const ax = D[3 * j], ay = D[3 * j + 1], az = D[3 * j + 2];
      const bx = D[3 * j + 3] - ax, by = D[3 * j + 4] - ay, bz = D[3 * j + 5] - az;
      const bb = bx * bx + by * by + bz * bz;
      let s = bb > 1e-12 ? -(ax * bx + ay * by + az * bz) / bb : 0;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const m = Math.hypot(ax + s * bx, ay + s * by, az + s * bz);
      if (m < best) { best = m; bestJ = j; bestS = s; }
    }
    if (bestJ < 0) continue;
    let tc = path.t[bestJ] + bestS * (path.t[bestJ + 1] - path.t[bestJ]);
    if (best < REFINE_KM) {   // exact: golden-section on the Hermite curves around the segment
      const sv = new Float64Array(6), so = new Float64Array(6);
      const dist = (t) => { path.state(t, sv); eph.state(i, t, so); return Math.hypot(so[0] - sv[0], so[1] - sv[1], so[2] - sv[2]); };
      let a = path.t[Math.max(0, bestJ - 1)], b = path.t[Math.min(M - 1, bestJ + 2)];
      a = Math.max(a, tMin);
      const g = 0.6180339887;
      let c = b - g * (b - a), d = a + g * (b - a), fc = dist(c), fd = dist(d);
      for (let it = 0; it < 60 && b - a > 1e-3; it++) {
        if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = dist(c); }
        else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = dist(d); }
      }
      tc = (a + b) / 2;
      const m = dist(tc);
      if (Number.isFinite(m)) best = Math.min(best, m);
    }
    path.state(tc, st);
    const so = eph.state(i, tc, new Float64Array(6));
    const dr = [so[0] - st[0], so[1] - st[1], so[2] - st[2]];
    const dv = [so[3] - st[3], so[4] - st[4], so[5] - st[5]];
    // RTN frame of the vehicle
    const rn = Math.hypot(st[0], st[1], st[2]);
    const R = [st[0] / rn, st[1] / rn, st[2] / rn];
    const h = [st[1] * st[5] - st[2] * st[4], st[2] * st[3] - st[0] * st[5], st[0] * st[4] - st[1] * st[3]];
    const hn = Math.hypot(...h) || 1;
    const Nn = [h[0] / hn, h[1] / hn, h[2] / hn];
    const T = [Nn[1] * R[2] - Nn[2] * R[1], Nn[2] * R[0] - Nn[0] * R[2], Nn[0] * R[1] - Nn[1] * R[0]];
    out.miss[q] = best; out.tca[q] = tc; out.relSpeed[q] = Math.hypot(...dv);
    out.rtn[3 * q] = dr[0] * R[0] + dr[1] * R[1] + dr[2] * R[2];
    out.rtn[3 * q + 1] = dr[0] * T[0] + dr[1] * T[1] + dr[2] * T[2];
    out.rtn[3 * q + 2] = dr[0] * Nn[0] + dr[1] * Nn[1] + dr[2] * Nn[2];
    const m = eph.meta[i];
    out.pc[q] = collisionProbability(best, Math.sqrt(m.sigma ** 2 + MISSION_SIGMA_KM ** 2), m.hbr);
  }
  return out;
}

/** Sorted conjunction list (closest first, up to reportKm). */
export function conjunctions(eph, res, reportKm = 25) {
  const rows = [];
  for (let q = 0; q < res.miss.length; q++) {
    if (!(res.miss[q] <= reportKm)) continue;
    const m = eph.meta[res.index[q]];
    rows.push({ q, i: res.index[q], id: m.id, name: m.name, type: m.type, owner: m.owner, miss: res.miss[q], tca: res.tca[q],
      tcaDate: new Date(eph.epochMs + res.tca[q] * 1000), relSpeed: res.relSpeed[q],
      radial: res.rtn[3 * q], along: res.rtn[3 * q + 1], cross: res.rtn[3 * q + 2], sigma: m.sigma, hbr: m.hbr,
      pc: res.pc[q], risk: riskLevel(res.pc[q], res.miss[q]) });
  }
  rows.sort((a, b) => b.pc - a.pc || a.miss - b.miss);
  return rows;
}

export function summarize(res) {
  let red = 0, amber = 0, minMiss = Infinity, maxPc = 0, notHit = 1;
  for (let q = 0; q < res.miss.length; q++) {
    const lv = riskLevel(res.pc[q], res.miss[q]);
    if (lv === 'RED') red++; else if (lv === 'AMBER') amber++;
    minMiss = Math.min(minMiss, res.miss[q]); maxPc = Math.max(maxPc, res.pc[q]); notHit *= 1 - res.pc[q];
  }
  return { red, amber, minMiss, maxPc, totalPc: 1 - notHit };
}

/** Coarse prune used by the workers: per object, the smallest linear closest approach to any of
 *  several vehicle paths (all sampled ON the ephemeris grid, so no interpolation is needed). */
export function minDistanceToPaths(pos, ok, steps, objIndex, paths) {
  let best = Infinity;
  const base = objIndex * steps;
  for (const p of paths) {        // p: { k0 (grid index of first sample), r: Float64Array(3m), m }
    for (let j = 0; j < p.m - 1; j++) {
      const k = p.k0 + j;
      if (k < 0 || k + 1 >= steps || !ok[base + k] || !ok[base + k + 1]) continue;
      const o = (base + k) * 3;
      const ax = pos[o] - p.r[3 * j], ay = pos[o + 1] - p.r[3 * j + 1], az = pos[o + 2] - p.r[3 * j + 2];
      const bx = pos[o + 3] - p.r[3 * j + 3] - ax, by = pos[o + 4] - p.r[3 * j + 4] - ay, bz = pos[o + 5] - p.r[3 * j + 5] - az;
      const bb = bx * bx + by * by + bz * bz;
      let s = bb > 1e-12 ? -(ax * bx + ay * by + az * bz) / bb : 0;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const m = Math.hypot(ax + s * bx, ay + s * by, az + s * bz);
      if (m < best) best = m;
    }
  }
  return best;
}
