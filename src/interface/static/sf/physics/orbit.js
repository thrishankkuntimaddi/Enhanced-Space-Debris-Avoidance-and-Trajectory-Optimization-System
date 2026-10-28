// Orbital mechanics in SI units: force model, orbital elements, numerical propagation.
import { MU, RE, J2, OMEGA_E } from './constants.js';
import { cross, dot, norm, altitude } from './frames.js';
import { atmosphere } from './atmosphere.js';

/** Gravity with the J2 oblateness term (m/s^2). J2 makes the orbit plane precess ~5 deg/day in
 *  LEO, which over a few hours moves a satellite by tens of km, so it is not optional here. */
export function gravity(r) {
  const [x, y, z] = r;
  const r2 = x * x + y * y + z * z, rn = Math.sqrt(r2);
  const k = -MU / (r2 * rn);
  const f = 1.5 * J2 * (RE * RE) / r2, zz = (5 * z * z) / r2;
  return [k * x * (1 + f * (1 - zz)), k * y * (1 + f * (1 - zz)), k * z * (1 + f * (3 - zz))];
}

/** Drag on a ballistic body with area/mass ratio aOverM (m^2/kg) and drag coefficient cd. */
export function dragAccel(r, v, cdA_over_m) {
  const h = altitude(r);
  if (h > 1.0e6 || cdA_over_m === 0) return [0, 0, 0];
  const { rho } = atmosphere(h);
  const vr = [v[0] + OMEGA_E * r[1], v[1] - OMEGA_E * r[0], v[2]];   // relative to rotating air
  const k = -0.5 * rho * norm(vr) * cdA_over_m;
  return [k * vr[0], k * vr[1], k * vr[2]];
}

/** Fixed-step RK4 for an unpowered body (gravity + J2 + drag). Returns new [r, v]. */
export function rk4Coast(r, v, dt, cdA_over_m = 0) {
  const acc = (rr, vv) => {
    const g = gravity(rr), d = dragAccel(rr, vv, cdA_over_m);
    return [g[0] + d[0], g[1] + d[1], g[2] + d[2]];
  };
  const k1v = acc(r, v), k1r = v;
  const r2 = r.map((x, i) => x + 0.5 * dt * k1r[i]), v2 = v.map((x, i) => x + 0.5 * dt * k1v[i]);
  const k2v = acc(r2, v2), k2r = v2;
  const r3 = r.map((x, i) => x + 0.5 * dt * k2r[i]), v3 = v.map((x, i) => x + 0.5 * dt * k2v[i]);
  const k3v = acc(r3, v3), k3r = v3;
  const r4 = r.map((x, i) => x + dt * k3r[i]), v4 = v.map((x, i) => x + dt * k3v[i]);
  const k4v = acc(r4, v4), k4r = v4;
  return [
    r.map((x, i) => x + dt / 6 * (k1r[i] + 2 * k2r[i] + 2 * k3r[i] + k4r[i])),
    v.map((x, i) => x + dt / 6 * (k1v[i] + 2 * k2v[i] + 2 * k3v[i] + k4v[i])),
  ];
}

/** Classical elements from an inertial state (SI). Angles in radians. */
export function elements(r, v) {
  const rn = norm(r), vn = norm(v);
  const h = cross(r, v), hn = norm(h);
  const energy = vn * vn / 2 - MU / rn;
  const a = -MU / (2 * energy);
  const evec = cross(v, h).map((c, i) => c / MU - r[i] / rn);
  const e = norm(evec);
  const inc = Math.acos(Math.max(-1, Math.min(1, h[2] / hn)));
  const nvec = [-h[1], h[0], 0], nn = norm(nvec);
  let raan = nn > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, nvec[0] / nn))) : 0;
  if (nvec[1] < 0) raan = 2 * Math.PI - raan;
  let nu = e > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, dot(evec, r) / (e * rn)))) : 0;
  if (dot(r, v) < 0) nu = 2 * Math.PI - nu;
  const rp = a * (1 - e), ra = e < 1 ? a * (1 + e) : Infinity;
  const period = e < 1 ? 2 * Math.PI * Math.sqrt(a * a * a / MU) : Infinity;
  // time to apoapsis via eccentric / mean anomaly
  let tApo = Infinity, tPeri = Infinity;
  if (e < 1 && e > 1e-6) {
    const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
    let M = E - e * Math.sin(E);
    if (M < 0) M += 2 * Math.PI;
    const n = Math.sqrt(MU / (a * a * a));
    tApo = ((Math.PI - M + 2 * Math.PI) % (2 * Math.PI)) / n;
    tPeri = ((2 * Math.PI - M) % (2 * Math.PI)) / n;
  }
  return {
    a, e, inc, raan, nu, energy, period, tApo, tPeri,
    apoAlt: ra - RE, periAlt: rp - RE, h: hn,
    incDeg: inc * 180 / Math.PI, raanDeg: raan * 180 / Math.PI,
  };
}

export const circularSpeed = (rMeters) => Math.sqrt(MU / rMeters);

/** Propagate a coasting state for `duration` seconds, sampling every `sampleDt`.
 *  Returns { t: Float64Array, r: Float64Array(3n), v: Float64Array(3n) } with t relative to start. */
export function propagate(r0, v0, duration, sampleDt = 10, stepDt = 10, cdA_over_m = 0) {
  const n = Math.floor(duration / sampleDt) + 1;
  const T = new Float64Array(n), R = new Float64Array(3 * n), V = new Float64Array(3 * n);
  let r = r0.slice(), v = v0.slice(), t = 0;
  const sub = Math.max(1, Math.round(sampleDt / stepDt)), h = sampleDt / sub;
  for (let i = 0; i < n; i++) {
    T[i] = t; R.set(r, 3 * i); V.set(v, 3 * i);
    if (i === n - 1) break;
    for (let k = 0; k < sub; k++) [r, v] = rk4Coast(r, v, h, cdA_over_m);
    t += sampleDt;
  }
  return { t: T, r: R, v: V };
}
