// Flight simulator: pad -> orbit, integrated in the inertial (TEME) frame.
//
// Forces: thrust (pressure-corrected nozzle thrust, constant mass flow), gravity with J2,
// aerodynamic drag in the co-rotating U.S. 1976 atmosphere with a Mach-dependent Cd.
// Integration: RK4 with the mass falling linearly inside each step; steps are cut exactly
// at propellant depletion so staging happens at the right instant.
//
// Guidance (the autopilot; the player can override throttle, steering and staging):
//   1. vertical rise, then a pitch-over "kick" of kickDeg toward the launch azimuth
//      (azimuth corrected for Earth's rotation so the orbit lands at the target inclination);
//   2. gravity turn: thrust along the air-relative velocity (zero angle of attack) through the
//      dense atmosphere, throttling to hold dynamic pressure under the vehicle's limit;
//   3. closed-loop vacuum guidance: the radial channel flies a linear-in-time acceleration
//      profile that reaches the target radius with zero climb rate at burnout, and the
//      horizontal channel thrusts along the velocity-to-be-gained toward circular speed in the
//      target plane (which also nulls any inclination error);
//   4. vehicles with a kick stage (Electron) cut off once apoapsis reaches the target, coast,
//      and circularise at apoapsis; restartable stages do the same if direct insertion left
//      the orbit noticeably elliptical.
import { G0, MU, RE, OMEGA_E, DEG } from './constants.js';
import { gmst, julian } from './time.js';
import { add, sub, scale, dot, cross, norm, unit, geodeticToEcef, rotZ, airVelocity, altitude, enu, inertialToGeodetic } from './frames.js';
import { atmosphere, dragCoefficient } from './atmosphere.js';
import { gravity, elements, rk4Coast, circularSpeed } from './orbit.js';

const P0 = 101325;
const SEP_DELAY = 2.0;            // s between cutoff and separation / next ignition
const Q_ALPHA_LIMIT = 160000;     // Pa*deg: aerodynamic bending limit
const BREAKUP_Q_FACTOR = 1.3;     // structural margin above the design max-Q

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const area = (d) => Math.PI * d * d / 4;

export function launchAzimuth(site, r0, targetAltKm, incDeg, branch) {
  const latGc = Math.asin(r0[2] / norm(r0));
  let s = Math.cos(incDeg * DEG) / Math.cos(latGc);
  const reachable = Math.abs(s) <= 1;
  s = clamp(s, -1, 1);
  let beta = Math.asin(s);                              // inertial azimuth, northbound branch
  if (branch === 'south') beta = Math.PI - beta;
  const vOrb = circularSpeed(RE + targetAltKm * 1000);
  const vEarth = OMEGA_E * norm(r0) * Math.cos(latGc);
  const betaRot = Math.atan2(vOrb * Math.sin(beta) - vEarth, vOrb * Math.cos(beta));
  return { inertialDeg: beta / DEG, rotatingDeg: betaRot / DEG, reachable, minIncDeg: Math.abs(latGc) / DEG };
}

/** Unit normal of the orbit plane with inclination inc that contains position r, on the side of hRef. */
export function targetPlaneNormal(r, incRad, hRef) {
  const rh = unit(r);
  const zPerp = sub([0, 0, 1], scale(rh, rh[2]));
  const cosLat = norm(zPerp);
  const e = scale(zPerp, 1 / cosLat), f = cross(rh, e);
  const c1 = clamp(Math.cos(incRad) / cosLat, -1, 1), c2 = Math.sqrt(1 - c1 * c1);
  const a = add(scale(e, c1), scale(f, c2)), b = add(scale(e, c1), scale(f, -c2));
  return dot(a, hRef) >= dot(b, hRef) ? a : b;
}

export class FlightSim {
  constructor(cfg) {
    const { vehicle, site, payloadKg, targetAltKm, targetIncDeg, launchDate, kickDeg = 3, kickSpeed = 55 } = cfg;
    this.cfg = { ...cfg, kickDeg, kickSpeed };
    this.veh = vehicle; this.site = site;
    this.payload = payloadKg;
    // guidance aims at target + bias: the flight computer calibrates the bias in pre-flight so the
    // osculating apoapsis prediction (perturbed by J2) lands the real orbit on the target
    this.hTarget = targetAltKm * 1000;
    this.hT = (targetAltKm + (cfg.guidanceBiasKm || 0)) * 1000; this.rT = RE + this.hT;
    // Insertion strategy. Low targets: direct insertion into the circular orbit. Higher targets:
    // insert at ~200 km into a transfer ellipse whose apoapsis is the target, coast half an orbit,
    // circularise there (Hohmann-style: much cheaper than lofting the upper stage straight up).
    this.hIns = this.hT <= 260e3 ? this.hT : 200e3;
    this.rIns = RE + this.hIns;
    this.vIns = Math.sqrt(MU * (2 / this.rIns - 2 / (this.rIns + this.rT)));
    this.transfer = this.hIns < this.hT;
    this.inc = targetIncDeg * DEG;
    this.T0 = launchDate;
    this.theta0 = gmst(julian(launchDate));
    const ecef = geodeticToEcef(site.lat, site.lon, site.alt || 0);
    this.r = rotZ(ecef, this.theta0);
    this.v = airVelocity(this.r);
    this.padR = ecef;
    const branch = cfg.branch || (site.branch === 'south' ? 'south' : 'north');
    this.az = launchAzimuth(site, this.r, targetAltKm, targetIncDeg, branch);
    this.t = 0;
    this.phase = 'PAD';           // PAD -> ASCENT -> COAST -> ORBIT | FAILED
    this.mode = 'VERTICAL';
    this.stage = 0;
    this.prop = vehicle.stages.map((s) => s.prop);
    this.boosterGroups = [];
    if (vehicle.boosters) {
      const b = vehicle.boosters, air = b.airLit || 0;
      this.boosterGroups.push({ n: b.count - air, prop: b.prop, litAt: 0, lit: false, attached: true });
      if (air) this.boosterGroups.push({ n: air, prop: b.prop, litAt: b.airLitAt, lit: false, attached: true, airLit: true });
    }
    this.fairing = true;
    this.payloadAttached = true;
    this.engineOn = false;
    this.ignitionAt = 0;
    this.throttle = 1;
    this.manualThrottle = null;   // player override (0..1)
    this.steer = { pitch: 0, yaw: 0 };   // player offsets, degrees
    this.autoStage = true;
    this.stagePending = false;
    this.events = [];
    this.telemetry = [];
    this.spent = [];
    this.losses = { ideal: 0, gravity: 0, drag: 0, steering: 0 };
    this.maxQ = 0; this.maxQAt = 0; this.maxG = 0; this.maxQAlpha = 0; this._maxqLogged = false;
    this.att = unit(this.r);
    this.kickStart = null;
    this.qPrev = 0;
    this.lastTelemetry = -1;
    this.hasKick = vehicle.stages.some((s) => s.kick);
    this.insertion = null;
    this.failure = null;
    this.snap = this._snapshot(0, 0, 0, 0);
  }

  // ── bookkeeping ────────────────────────────────────────────────────────────
  get stageDef() { return this.veh.stages[this.stage]; }
  get theta() { return this.theta0 + OMEGA_E * this.t; }
  get date() { return new Date(this.T0.getTime() + this.t * 1000); }

  mass() {
    let m = (this.payloadAttached ? this.payload : 0) + (this.fairing ? this.veh.fairing.mass : 0);
    for (let j = this.stage; j < this.veh.stages.length; j++) m += this.veh.stages[j].dry + this.prop[j];
    for (const g of this.boosterGroups) if (g.attached) m += g.n * (this.veh.boosters.dry + g.prop);
    return m;
  }

  refArea() {
    let d = this.stageDef.diameter;
    if (this.fairing) d = Math.max(d, this.veh.fairing.diameter);
    let A = area(d);
    for (const g of this.boosterGroups) if (g.attached) A += g.n * area(this.veh.boosters.diameter);
    return A;
  }

  log(key, label, detail = '') {
    this.events.push({ t: this.t, key, label, detail });
    if (this.onEvent) this.onEvent(this.events[this.events.length - 1]);
  }

  // ── propulsion ─────────────────────────────────────────────────────────────
  /** Active engines: [{F_vac, F_sl, mdot, kind, ref}] with throttle applied to mass flow. */
  engines() {
    const out = [];
    if (this.phase === 'PAD' || this.phase === 'FAILED') return out;
    const s = this.stageDef;
    const boostersOn = this.boosterGroups.some((g) => g.attached);
    if (this.engineOn && this.t >= this.ignitionAt && this.prop[this.stage] > 0) {
      let thr = this.throttle;
      if (boostersOn && this.veh.coreThrottleWithBoosters && this.stage === 0) thr = Math.min(thr, this.veh.coreThrottleWithBoosters);
      out.push({ F_vac: s.thrustVac * thr, F_sl: s.thrustSL * thr, mdot: thr * s.thrustVac / (s.ispVac * G0), kind: 'stage', ref: this.stage });
    }
    for (const g of this.boosterGroups) {
      if (g.attached && g.lit && g.prop > 0) {
        const b = this.veh.boosters;
        out.push({ F_vac: g.n * b.thrustVac, F_sl: g.n * b.thrustSL, mdot: g.n * b.thrustVac / (b.ispVac * G0), kind: 'booster', ref: g });
      }
    }
    return out;
  }

  thrustAt(engs, p) {
    let F = 0;
    for (const e of engs) F += Math.max(0, e.F_vac - (e.F_vac - e.F_sl) * p / P0);
    return F;
  }

  // ── guidance ───────────────────────────────────────────────────────────────
  /** Burn time needed to gain dv (m/s) with the remaining stages, at full throttle. */
  timeToGain(dv, includeKick = true) {
    let t = 0, m = this.mass();
    for (let j = this.stage; j < this.veh.stages.length && dv > 0; j++) {
      const s = this.veh.stages[j];
      if (s.kick && !includeKick) break;
      const ve = s.ispVac * G0, md = s.thrustVac / ve, left = this.prop[j];
      if (j > this.stage) t += SEP_DELAY + s.ullage_s;
      const dvj = left > 0 ? ve * Math.log(m / (m - left)) : 0;
      if (dv <= dvj) return t + m * (1 - Math.exp(-dv / ve)) / md;
      t += left / md; dv -= dvj; m -= left + s.dry;
    }
    return dv > 0 ? Infinity : t;
  }

  /** Burn time left on the non-kick stages at full throttle (s), including staging gaps. */
  mainBurnLeft() {
    let t = 0;
    for (let j = this.stage; j < this.veh.stages.length; j++) {
      const s = this.veh.stages[j];
      if (s.kick) break;
      if (j > this.stage) t += SEP_DELAY + s.ullage_s;
      t += this.prop[j] / (s.thrustVac / (s.ispVac * G0));
    }
    return t;
  }

  /** Remaining ideal delta-v (vacuum), m/s. */
  deltaVLeft(includeKick = true) {
    let dv = 0, m = this.mass();
    for (let j = this.stage; j < this.veh.stages.length; j++) {
      const s = this.veh.stages[j];
      if (s.kick && !includeKick) break;
      const left = this.prop[j];
      if (left > 0) dv += s.ispVac * G0 * Math.log(m / (m - left));
      m -= left + s.dry;
    }
    return dv;
  }

  /** Commanded thrust direction (unit, inertial). */
  guidance(env) {
    const { r, vRel, h, q } = env;
    const up = unit(r);
    const { east, north } = enu(r);
    const heading = add(scale(north, Math.cos(this.az.rotatingDeg * DEG)), scale(east, Math.sin(this.az.rotatingDeg * DEG)));
    const tilt = (deg) => unit(add(scale(up, Math.cos(deg * DEG)), scale(heading, Math.sin(deg * DEG))));
    let u = up;
    switch (this.mode) {
      case 'VERTICAL':
        if (dot(vRel, up) > this.cfg.kickSpeed && h > 150) { this.mode = 'KICK'; this.kickStart = this.t; this.log('kick', 'Pitch kick', `${this.cfg.kickDeg.toFixed(1)}° toward ${this.az.rotatingDeg.toFixed(1)}°`); }
        break;
      case 'KICK': {
        const f = clamp((this.t - this.kickStart) / 8, 0, 1);
        u = tilt(this.cfg.kickDeg * f);
        const vAngle = Math.acos(clamp(dot(unit(vRel), up), -1, 1)) / DEG;
        if (f >= 1 && vAngle >= this.cfg.kickDeg) { this.mode = 'GRAVITY_TURN'; this.log('gturn', 'Gravity turn', 'zero angle of attack'); }
        break;
      }
      case 'GRAVITY_TURN':
        u = unit(vRel);
        if (this.stage >= 1 || (q < 1000 && h > 45000 && this.t > 60)) { this.mode = 'CLOSED_LOOP'; this.log('guidance', 'Closed-loop guidance', 'targeting orbit'); }
        break;
      case 'CLOSED_LOOP': u = this.closedLoop(env); break;
      case 'CIRCULARIZE': u = this.circularize(env); break;
      default: u = norm(this.v) > 0 ? unit(this.v) : up;
    }
    // autopilot respects the aerodynamic load limit: cap the angle of attack where q is significant
    if (q > 200 && this.mode !== 'VERTICAL' && norm(vRel) > 1) {
      const vh = unit(vRel), ang = Math.acos(clamp(dot(u, vh), -1, 1));
      const maxA = Math.min(Math.PI / 2, (0.45 * Q_ALPHA_LIMIT / q) * DEG);
      if (ang > maxA) {
        const perp = unit(sub(u, scale(vh, dot(u, vh))));
        u = unit(add(scale(vh, Math.cos(maxA)), scale(perp, Math.sin(maxA))));
      }
    }
    // player steering offsets: pitch toward/away from up, yaw about up
    if (this.steer.pitch || this.steer.yaw) {
      const right = unit(cross(u, up));
      const rotated = (vec, axis, ang) => {   // Rodrigues
        const c = Math.cos(ang), s = Math.sin(ang);
        return add(add(scale(vec, c), scale(cross(axis, vec), s)), scale(axis, dot(axis, vec) * (1 - c)));
      };
      if (norm(right) > 1e-6) u = rotated(u, right, this.steer.pitch * DEG);
      u = unit(rotated(u, up, this.steer.yaw * DEG));
    }
    return u;
  }

  _planeDir(r, v) {
    const n = targetPlaneNormal(r, this.inc, cross(r, v));
    return unit(cross(n, unit(r)));
  }

  closedLoop({ r, v, aT, h }) {
    const up = unit(r), rn = norm(r);
    const hdot = dot(v, up);
    const vh = sub(v, scale(up, hdot));
    const d = this._planeDir(r, v);
    // target speed at the current radius for an orbit with periapsis here and apoapsis at the target
    const vTarget = this.transfer ? this.vIns * this.rIns / Math.max(rn, this.rIns) : circularSpeed(this.rT);
    const vGo = sub(scale(d, vTarget), vh);
    let T = this.timeToGain(norm(vGo) + 0.3 * Math.abs(hdot), !this.hasKick);
    // a kick-stage vehicle may not reach the insertion speed on its main stages: fly so that they
    // burn out at the insertion altitude with zero climb rate, then the kick stage takes over
    if (!Number.isFinite(T) && this.hasKick) T = this.mainBurnLeft();
    if (Number.isFinite(T) && T > 15) {
      const A = 6 * (this.hIns - (rn - RE)) / (T * T) - 4 * hdot / T;
      this._radialCmd = A;
    } else if (this._radialCmd === undefined) this._radialCmd = 0;
    const gEff = MU / (rn * rn) - dot(vh, vh) / rn;
    // a very low-thrust stage (kick stage) cannot shape the climb: it just thrusts horizontally
    const sinG = aT > 1.5 ? clamp((this._radialCmd + gEff) / aT, -0.6, 0.9) : 0;
    const hd = norm(vGo) > 1 ? unit(vGo) : d;
    return unit(add(scale(hd, Math.sqrt(1 - sinG * sinG)), scale(up, sinG)));
  }

  circularize({ r, v, aT }) {
    const up = unit(r), rn = norm(r);
    const hdot = dot(v, up);
    const vh = sub(v, scale(up, hdot));
    const vGo = sub(scale(this._planeDir(r, v), circularSpeed(rn)), vh);
    const gEff = MU / (rn * rn) - dot(vh, vh) / rn;
    const sinG = aT > 0 ? clamp((-hdot / 20 + gEff) / aT, -0.5, 0.5) : 0;
    return unit(add(scale(unit(vGo), Math.sqrt(1 - sinG * sinG)), scale(up, sinG)));
  }

  // ── autopilot throttle ─────────────────────────────────────────────────────
  autoThrottle(q, m) {
    const s = this.stageDef;
    let thr = 1;
    if (s.minThrottle < 1) {
      const qT = 0.78 * this.veh.qLimit;
      if (q > qT) thr = Math.min(thr, 1 - 4 * (q - qT) / qT);
      const F = s.thrustVac;
      thr = Math.min(thr, this.veh.gLimit * G0 * m / F);
      thr = clamp(thr, s.minThrottle, 1);
    }
    return thr;
  }

  // ── staging ────────────────────────────────────────────────────────────────
  _spawnSpent(name, kind, mass, diameter, offset = [0, 0, 0], dv = [0, 0, 0], length = 10) {
    const cd = kind === 'fairing' ? 1.2 : 0.8;
    this.spent.push({ name, kind, r: add(this.r, offset), v: add(this.v, dv), mass, length, diameter,
      cdA_m: cd * diameter * length / mass, t0: this.t, impact: null, alive: true, spin: Math.random() * 2 - 1 });
  }

  separateBoosters(g) {
    g.attached = false;
    const b = this.veh.boosters;
    const up = unit(this.r), side = unit(cross(up, [0, 0, 1]));
    for (let i = 0; i < g.n; i++) {
      const ang = (i / g.n) * 2 * Math.PI + (g.airLit ? Math.PI / g.n : 0);
      const out = add(scale(side, Math.cos(ang)), scale(unit(cross(up, side)), Math.sin(ang)));
      this._spawnSpent(`${b.name} ${i + 1}`, 'booster', b.dry + g.prop, b.diameter, scale(out, b.diameter), scale(out, 3), b.length);
    }
    this.log('booster_sep', g.airLit ? 'Air-lit boosters separated' : 'Booster separation', `${g.n} × ${b.engine.split('×').pop().trim()}`);
  }

  doStage() {
    const s = this.stageDef;
    if (this.stage >= this.veh.stages.length - 1) return false;
    // boosters still attached on a parallel-staged core go with it
    for (const g of this.boosterGroups) if (g.attached) this.separateBoosters(g);
    this._spawnSpent(s.name, 'stage', s.dry + this.prop[this.stage], s.diameter, scale(unit(this.v), -s.length * 0.6), scale(unit(this.v), -1.5), s.length);
    this.log('stage_sep', `${s.name} separation`, `${(this.prop[this.stage] / 1000).toFixed(1)} t residual propellant`);
    this.stage++;
    const n = this.stageDef;
    this.ignitionAt = this.t + SEP_DELAY + n.ullage_s;
    this.engineOn = !n.kick || this.mode === 'CLOSED_LOOP';
    this.stagePending = false;
    if (n.kick) { this.engineOn = false; this.mode = 'COAST_TO_APO'; this.phase = 'COAST'; }
    return true;
  }

  stageNow() {   // player-commanded staging (Space)
    if (this.phase === 'PAD') return this.liftoff();
    const att = this.boosterGroups.find((g) => g.attached && g.lit);
    if (att && att.prop <= 0) { this.separateBoosters(att); return true; }
    return this.doStage();
  }

  liftoff() {
    if (this.phase !== 'PAD') return false;
    this.phase = 'ASCENT';
    this.engineOn = true;
    for (const g of this.boosterGroups) if (!g.airLit) g.lit = true;
    this.log('liftoff', 'Liftoff', `${this.veh.name} from ${this.site.name}`);
    return true;
  }

  fail(key, label, detail) {
    if (this.phase === 'FAILED') return;
    this.phase = 'FAILED'; this.engineOn = false; this.failure = { key, label, detail, t: this.t };
    this.log(key, label, detail);
  }

  // ── one integration step ───────────────────────────────────────────────────
  environment(r, v) {
    const h = altitude(r);
    const atm = atmosphere(h);
    const vRel = sub(v, airVelocity(r));
    const vr = norm(vRel);
    const q = 0.5 * atm.rho * vr * vr;
    const mach = atm.a > 0 ? vr / atm.a : 0;
    return { h, atm, vRel, vr, q, mach };
  }

  step(dtMax) {
    if (this.phase === 'PAD') { this.t += 0; return 0; }
    // events that depend on time
    for (const g of this.boosterGroups) if (g.airLit && !g.lit && g.attached && this.t >= g.litAt) { g.lit = true; this.log('airlit', 'Air-lit boosters ignition', `${g.n} strap-ons`); }

    let env = this.environment(this.r, this.v);
    let m = this.mass();
    // throttle
    if (this.stageDef && this.phase !== 'FAILED') {
      this.throttle = this.manualThrottle ?? this.autoThrottle(env.q, m);
      if (this.manualThrottle !== null && this.stageDef.minThrottle >= 1 && this.manualThrottle < 1) this.throttle = 1;  // solids can't throttle
      if (this.manualThrottle !== null && this.manualThrottle > 0) this.throttle = Math.max(this.throttle, this.stageDef.minThrottle);
    }
    let engs = this.engines();
    if (this.manualThrottle === 0) engs = engs.filter((e) => e.kind === 'booster' || this.stageDef.minThrottle >= 1);
    const mdot = engs.reduce((a, e) => a + e.mdot, 0);
    const F0 = this.thrustAt(engs, env.atm.p);
    const aT = F0 / m;
    const u = engs.length ? this.guidance({ r: this.r, v: this.v, vRel: env.vRel, h: env.h, q: env.q, aT }) : (this.mode === 'CLOSED_LOOP' || this.mode === 'CIRCULARIZE' ? this.guidance({ r: this.r, v: this.v, vRel: env.vRel, h: env.h, q: env.q, aT: 0 }) : this.att);
    this.att = u;

    // step length: cut exactly at the first propellant depletion
    let dt = dtMax;
    for (const e of engs) {
      const left = e.kind === 'stage' ? this.prop[e.ref] : e.ref.prop * e.ref.n;
      const tb = left / e.mdot;
      if (tb < dt) dt = Math.max(tb, 1e-4);
    }
    if (!engs.length && this.ignitionAt > this.t) dt = Math.min(dt, Math.max(1e-3, this.ignitionAt - this.t));

    const A = this.refArea();
    const acc = (r, v, tau) => {
      const mm = m - mdot * tau;
      const g = gravity(r);
      const e = this.environment(r, v);
      const F = this.thrustAt(engs, e.atm.p);
      const cd = dragCoefficient(e.mach);
      const kD = e.vr > 0 ? -0.5 * e.atm.rho * e.vr * cd * A / mm : 0;
      return [g[0] + F / mm * u[0] + kD * e.vRel[0], g[1] + F / mm * u[1] + kD * e.vRel[1], g[2] + F / mm * u[2] + kD * e.vRel[2]];
    };
    const r = this.r, v = this.v;
    const k1v = acc(r, v, 0), k1r = v;
    const r2 = axpyArr(0.5 * dt, k1r, r), v2 = axpyArr(0.5 * dt, k1v, v);
    const k2v = acc(r2, v2, 0.5 * dt), k2r = v2;
    const r3 = axpyArr(0.5 * dt, k2r, r), v3 = axpyArr(0.5 * dt, k2v, v);
    const k3v = acc(r3, v3, 0.5 * dt), k3r = v3;
    const r4 = axpyArr(dt, k3r, r), v4 = axpyArr(dt, k3v, v);
    const k4v = acc(r4, v4, dt), k4r = v4;
    const rN = r.map((x, i) => x + dt / 6 * (k1r[i] + 2 * k2r[i] + 2 * k3r[i] + k4r[i]));
    const vN = v.map((x, i) => x + dt / 6 * (k1v[i] + 2 * k2v[i] + 2 * k3v[i] + k4v[i]));

    // loss accounting (projected on the inertial velocity: sums exactly to d|v|)
    const vh = norm(v) > 0 ? unit(v) : unit(r);
    const g = gravity(r);
    const cd = dragCoefficient(env.mach);
    const dragA = env.vr > 0 ? scale(env.vRel, -0.5 * env.atm.rho * env.vr * cd * A / m) : [0, 0, 0];
    this.losses.ideal += aT * dt;
    this.losses.gravity += -dot(g, vh) * dt;
    this.losses.drag += -dot(dragA, vh) * dt;
    this.losses.steering += aT * (1 - dot(u, vh)) * dt;

    // propellant
    for (const e of engs) {
      if (e.kind === 'stage') this.prop[e.ref] = Math.max(0, this.prop[e.ref] - e.mdot * dt);
      else e.ref.prop = Math.max(0, e.ref.prop - (e.mdot / e.ref.n) * dt);
    }
    // pad hold-down: no sinking back through the pad in the first seconds
    if (this.t < 15 && altitude(rN) < (this.site.alt || 0) - 0.5) {
      this.r = rotZ(this.padR, this.theta0 + OMEGA_E * (this.t + dt));
      this.v = airVelocity(this.r);
    } else { this.r = rN; this.v = vN; }
    this.t += dt;

    // spent stages fall ballistically
    for (const s of this.spent) {
      if (!s.alive) continue;
      [s.r, s.v] = rk4Coast(s.r, s.v, dt, s.cdA_m);
      if (altitude(s.r) <= 0) {
        s.alive = false;
        const geo = inertialToGeodetic(s.r, this.theta);
        s.impact = { t: this.t, lat: geo.lat, lon: geo.lon, downrange: this.downrange(s.r) };
        this.log('impact', `${s.name} impact`, `${s.impact.downrange.toFixed(0)} km downrange`);
      } else if (this.t - s.t0 > 4000) s.alive = false;  // reached orbit or long arc: stop tracking
    }

    this._after(env, aT, u, m);
    return dt;
  }

  _after(env0, aT, u, m) {
    const env = this.environment(this.r, this.v);
    // structural checks
    const aoa = norm(env.vRel) > 1 ? Math.acos(clamp(dot(u, unit(env.vRel)), -1, 1)) / DEG : 0;
    const qAlpha = env.q * aoa;
    const gLoad = aT / G0;
    if (env.q > this.maxQ) { this.maxQ = env.q; this.maxQAt = this.t; }
    if (!this._maxqLogged && this.maxQ > 5000 && env.q < 0.97 * this.maxQ) {
      this._maxqLogged = true;
      this.log('maxq', 'Max-Q', `${(this.maxQ / 1000).toFixed(1)} kPa at T+${this.maxQAt.toFixed(0)} s`);
    }
    this.maxG = Math.max(this.maxG, gLoad);
    if (env.q > 1000) this.maxQAlpha = Math.max(this.maxQAlpha, qAlpha);
    if (this.phase === 'ASCENT' || this.phase === 'COAST') {
      if (env.q > this.veh.qLimit * BREAKUP_Q_FACTOR) this.fail('breakup', 'Vehicle breakup', `dynamic pressure ${(env.q / 1000).toFixed(1)} kPa exceeded the structure`);
      else if (env.q > 1000 && qAlpha > Q_ALPHA_LIMIT) this.fail('breakup', 'Aerodynamic breakup', `q·α = ${(qAlpha / 1000).toFixed(0)} kPa·deg at ${aoa.toFixed(1)}° angle of attack`);
      else if (gLoad > this.veh.gLimit * 1.6) this.fail('overload', 'Payload overload', `${gLoad.toFixed(1)} g`);
    }
    if (env.h < -10 && this.t > 5) this.fail('crash', 'Ground impact', `${this.downrange(this.r).toFixed(0)} km downrange`);

    // fairing
    if (this.fairing && env.h > this.veh.fairing.sepAlt && env.q < 50) {
      this.fairing = false;
      const side = unit(cross(unit(this.r), unit(this.v)));
      this._spawnSpent('Fairing half A', 'fairing', this.veh.fairing.mass / 2, this.veh.fairing.diameter / 2, scale(side, 2), scale(side, 4), this.veh.fairing.length);
      this._spawnSpent('Fairing half B', 'fairing', this.veh.fairing.mass / 2, this.veh.fairing.diameter / 2, scale(side, -2), scale(side, -4), this.veh.fairing.length);
      this.log('fairing', 'Fairing separation', `${(env.h / 1000).toFixed(0)} km`);
    }

    // boosters burnout
    for (const g of this.boosterGroups) {
      if (g.attached && g.lit && g.prop <= 0) {
        if (!g._bo) { g._bo = this.t; this.log('beco', 'Booster burnout', ''); }
        if (this.autoStage && this.t - g._bo > 0.5) this.separateBoosters(g);
      }
    }

    if (this.phase === 'FAILED' || this.phase === 'ORBIT') return this._telemetry(env, aT, u, m);
    const el = elements(this.r, this.v);

    // stage burnout
    if (this.engineOn && this.prop[this.stage] <= 0 && !this.stagePending) {
      this.stagePending = true; this._burnoutAt = this.t;
      const last = this.stage >= this.veh.stages.length - 1;
      this.log('meco', last ? 'Final stage burnout' : `${this.stageDef.name} cutoff`, '');
      if (last) this.engineOn = false;
    }
    if (this.stagePending && this.autoStage && this.t - this._burnoutAt >= 0.5 && this.stage < this.veh.stages.length - 1) {
      const wasClosed = this.mode === 'CLOSED_LOOP';
      this.doStage();
      if (wasClosed && this.stageDef.kick && el.apoAlt > this.hT - 5000) { this.mode = 'COAST_TO_APO'; this.engineOn = false; }
      else if (this.stageDef.kick) { this.mode = 'CLOSED_LOOP'; this.engineOn = true; this.phase = 'ASCENT'; }
    }

    // cutoff logic
    if (this.mode === 'CLOSED_LOOP' && this.engineOn && this.t >= this.ignitionAt) {
      const reached = this.transfer ? el.apoAlt >= this.hT : el.a >= this.rT;
      if (reached && !this.stageDef.solid) {          // solid motors cannot be shut down
        this.engineOn = false;
        this.log('seco', this.transfer ? `${this.stageDef.name} cutoff: transfer orbit` : `${this.stageDef.name} cutoff`,
          `${(el.apoAlt / 1000).toFixed(0)} × ${(el.periAlt / 1000).toFixed(0)} km`);
        const needCirc = el.periAlt < this.hT - 10000;
        if (needCirc && !this.stageDef.restartable && this.stage < this.veh.stages.length - 1) {
          this.stagePending = false; this.doStage();          // e.g. Block I -> Fregat for the apoapsis burn
          this.engineOn = false; this.mode = 'COAST_TO_APO'; this.phase = 'COAST';
        } else if (needCirc && this.prop[this.stage] > 0 && (this.stageDef.restartable || this.stageDef.kick)) {
          this.mode = 'COAST_TO_APO'; this.phase = 'COAST';
        } else this.insert(el);
      }
    } else if (this.mode === 'COAST_TO_APO') {
      this.phase = 'COAST';
      const s = this.stageDef;
      const dvNeed = Math.max(0, circularSpeed(RE + el.apoAlt) - Math.sqrt(MU * (2 / (RE + el.apoAlt) - 1 / el.a)));
      const md = s.thrustVac / (s.ispVac * G0);
      const burn = this.mass() * (1 - Math.exp(-dvNeed / (s.ispVac * G0))) / md;
      if (el.tApo <= burn / 2 + s.ullage_s || el.tApo > el.period - 30) {
        this.mode = 'CIRCULARIZE'; this.engineOn = true; this.ignitionAt = this.t + s.ullage_s; this._eccPrev = el.e;
        this.log('circ_start', 'Circularisation burn', `Δv ≈ ${dvNeed.toFixed(0)} m/s with ${s.name}`);
      }
    } else if (this.mode === 'CIRCULARIZE' && this.t >= this.ignitionAt) {
      // done when horizontal speed reaches circular speed at the current radius (velocity-to-go
      // vanishes), or the tank is dry. (Osculating eccentricity is not used: J2 makes it jitter.)
      const up = unit(this.r), rn = norm(this.r);
      const vh = sub(this.v, scale(up, dot(this.v, up)));
      const vGoAlong = circularSpeed(rn) - dot(vh, this._planeDir(this.r, this.v));
      const done = vGoAlong <= 0.05 || el.periAlt >= el.apoAlt - 300 || this.prop[this.stage] <= 0;
      if (done) {
        this.engineOn = false;
        this.log('circ_end', 'Circularisation complete', `${(el.apoAlt / 1000).toFixed(0)} × ${(el.periAlt / 1000).toFixed(0)} km`);
        this.insert(el);
      }
    }

    // out of propellant on every stage without an orbit
    const allDry = this.prop.every((p, j) => j < this.stage || p <= 0) && !this.boosterGroups.some((g) => g.attached && g.prop > 0);
    if (allDry && this.phase !== 'ORBIT' && el.periAlt < 120000 && this.stage === this.veh.stages.length - 1 && this.t - (this._burnoutAt ?? this.t) > 1) {
      this.fail('suborbital', 'Insufficient Δv: suborbital', `apoapsis ${(el.apoAlt / 1000).toFixed(0)} km, periapsis ${(el.periAlt / 1000).toFixed(0)} km`);
    }
    return this._telemetry(env, aT, u, m);
  }

  insert(el) {
    if (el.periAlt < 120000) {
      return this.fail('suborbital', 'Orbit not achieved', `periapsis ${(el.periAlt / 1000).toFixed(0)} km: the vehicle will re-enter`);
    }
    this.phase = 'ORBIT'; this.mode = 'ORBIT'; this.engineOn = false;
    this.insertion = { t: this.t, date: this.date, r: this.r.slice(), v: this.v.slice(), el, mass: this.mass(),
      dvLeft: this.deltaVLeft(), propLeft: this.prop[this.stage] };
    this.log('orbit', 'Orbit insertion', `${(el.apoAlt / 1000).toFixed(1)} × ${(el.periAlt / 1000).toFixed(1)} km, i = ${el.incDeg.toFixed(2)}°`);
  }

  downrange(r) {
    const a = unit(rotZ(this.padR, this.theta)), b = unit(r);
    return Math.acos(clamp(dot(a, b), -1, 1)) * RE / 1000;
  }

  _snapshot(env, aT, u, m) {
    return { t: this.t };
  }

  _telemetry(env, aT, u, m) {
    const el = elements(this.r, this.v);
    const up = unit(this.r);
    const s = {
      t: this.t, phase: this.phase, mode: this.mode, stage: this.stage,
      alt: env.h / 1000, speed: norm(this.v), airspeed: env.vr, vs: dot(this.v, up),
      downrange: this.downrange(this.r), q: env.q, mach: env.mach, g: aT / G0, throttle: this.engineOn ? this.throttle : 0,
      mass: this.mass(), apo: el.apoAlt / 1000, peri: el.periAlt / 1000, inc: el.incDeg, ecc: el.e,
      pitch: 90 - Math.acos(clamp(dot(this.att, up), -1, 1)) / DEG,
      aoa: env.vr > 1 ? Math.acos(clamp(dot(this.att, unit(env.vRel)), -1, 1)) / DEG : 0,
      dvLeft: this.deltaVLeft(), pressure: env.atm.p,
    };
    this.snap = s;
    if (this.t - this.lastTelemetry >= 0.5) { this.telemetry.push(s); this.lastTelemetry = this.t; }
    return s;
  }

  /** Shorter steps as a cutoff approaches, so the engine stops within a few metres per second
   *  of the target instead of overshooting by a whole step of a 5 g burn. */
  cutoffDt(dtMax) {
    if (!this.engineOn || this.t < this.ignitionAt) return dtMax;
    const el = elements(this.r, this.v);
    const aT = Math.max(this.snap.g * G0, 0.01);
    if (this.mode === 'CLOSED_LOOP') {
      // remaining delta-v to the cutoff condition, from the vis-viva equation
      const rn = norm(this.r);
      const vNeed = this.transfer ? Math.sqrt(MU * (2 / rn - 2 / (rn + this.rT))) : Math.sqrt(MU * (2 / rn - 1 / this.rT));
      const margin = vNeed - norm(this.v);
      return clamp(0.3 * margin / aT, 0.002, dtMax);
    }
    if (this.mode === 'CIRCULARIZE') {
      const up = unit(this.r), vh = sub(this.v, scale(up, dot(this.v, up)));
      const margin = circularSpeed(norm(this.r)) - dot(vh, this._planeDir(this.r, this.v));
      return clamp(0.3 * margin / aT, 0.002, dtMax);
    }
    return dtMax;
  }

  /** Advance by `seconds` of simulated time with steps of at most `dtMax`. */
  advance(seconds, dtMax = 0.05) {
    if (this.phase === 'PAD' || seconds <= 0) return;
    const end = this.t + seconds;
    let guard = 0;
    while (this.t < end - 1e-9 && guard++ < 200000) {
      if (this.phase === 'ORBIT') {   // free flight: coast with large steps
        const h = Math.min(end - this.t, 5);
        [this.r, this.v] = rk4Coast(this.r, this.v, h, 0);
        this.t += h;
        continue;
      }
      const coasting = !this.engineOn || this.t < this.ignitionAt;
      const big = coasting && this.environment(this.r, this.v).h > 120000 ? Math.min(2, Math.max(0.05, (this.ignitionAt - this.t) || 2)) : this.cutoffDt(dtMax);
      this.step(Math.min(big, end - this.t));
      if (this.phase === 'FAILED' && this.failure.key === 'crash') break;
    }
    if (this.phase === 'ORBIT') this._telemetry(this.environment(this.r, this.v), 0, this.att, this.mass());
  }
}

function axpyArr(k, x, y) { return [k * x[0] + y[0], k * x[1] + y[1], k * x[2] + y[2]]; }

/** Run a whole flight without rendering. Returns the sim (for the pre-flight optimiser and tests). */
export function simulateFlight(cfg, { maxTime = 8000, dt = 0.1 } = {}) {
  const sim = new FlightSim(cfg);
  sim.liftoff();
  while (sim.t < maxTime && sim.phase !== 'ORBIT' && sim.phase !== 'FAILED') sim.advance(5, dt);
  return sim;
}

/** Pre-flight "flight computer": search the pitch-kick angle for the most propellant-efficient
 *  ascent that respects the structural limits. Returns { kickDeg, sim, tried }. */
export function optimizeAscent(cfg, kicks = [1.5, 3, 4.5, 6, 8, 10, 12.5, 15.5]) {
  const tried = [];
  let best = null;
  for (const k of kicks) {
    const sim = simulateFlight({ ...cfg, kickDeg: k }, { dt: 0.2 });
    const ok = sim.phase === 'ORBIT';
    const score = ok ? sim.insertion.dvLeft - 2 * Math.abs(sim.insertion.el.periAlt - sim.hT) / 1000 : -1e9 + (sim.snap?.apo ?? 0);
    tried.push({ kickDeg: k, ok, dvLeft: ok ? sim.insertion.dvLeft : 0, failure: sim.failure?.label, maxQ: sim.maxQ });
    if (!best || score > best.score) best = { kickDeg: k, sim, score };
  }
  // refine around the best
  for (const k of [best.kickDeg * 0.85, best.kickDeg * 1.15]) {
    const sim = simulateFlight({ ...cfg, kickDeg: k }, { dt: 0.2 });
    if (sim.phase === 'ORBIT') {
      const score = sim.insertion.dvLeft - 2 * Math.abs(sim.insertion.el.periAlt - sim.hT) / 1000;
      tried.push({ kickDeg: k, ok: true, dvLeft: sim.insertion.dvLeft, maxQ: sim.maxQ });
      if (score > best.score) best = { kickDeg: k, sim, score };
    }
  }
  // calibrate: fly once more aiming off by the observed error in mean altitude
  let bias = 0, sim = best.sim;
  if (sim.phase === 'ORBIT') {
    const el = sim.insertion.el, err = ((el.apoAlt + el.periAlt) / 2 - sim.hTarget) / 1000;
    if (Math.abs(err) > 0.5) {
      const s2 = simulateFlight({ ...cfg, kickDeg: best.kickDeg, guidanceBiasKm: -err }, { dt: 0.2 });
      const e2 = s2.phase === 'ORBIT' ? ((s2.insertion.el.apoAlt + s2.insertion.el.periAlt) / 2 - s2.hTarget) / 1000 : Infinity;
      if (Math.abs(e2) < Math.abs(err)) { bias = -err; sim = s2; }
    }
  }
  return { kickDeg: best.kickDeg, guidanceBiasKm: bias, sim, tried, ok: sim.phase === 'ORBIT' };
}
