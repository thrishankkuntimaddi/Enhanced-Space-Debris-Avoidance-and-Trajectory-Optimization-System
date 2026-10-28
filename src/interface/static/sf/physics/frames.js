// Vector helpers and reference frames. Inertial frame = TEME (z = Earth spin axis, x = mean
// equinox of date): the frame SGP4 outputs, so vehicle and catalog are compared like-for-like.
import { RE, FLATTENING, OMEGA_E } from './constants.js';

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
export const axpy = (k, x, y) => [k * x[0] + y[0], k * x[1] + y[1], k * x[2] + y[2]];

/** Geodetic (deg, deg, m) -> Earth-fixed position (m), WGS-84 ellipsoid. */
export function geodeticToEcef(latDeg, lonDeg, h = 0) {
  const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180;
  const e2 = FLATTENING * (2 - FLATTENING);
  const n = RE / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [(n + h) * Math.cos(lat) * Math.cos(lon), (n + h) * Math.cos(lat) * Math.sin(lon), (n * (1 - e2) + h) * Math.sin(lat)];
}

/** Rotate about z by angle theta: Earth-fixed -> inertial when theta = GMST. */
export function rotZ(v, theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

/** Inertial position -> geodetic latitude/longitude (deg) and height (m) (Bowring, 2 iterations). */
export function inertialToGeodetic(r, theta) {
  const e = rotZ(r, -theta);
  const e2 = FLATTENING * (2 - FLATTENING);
  const p = Math.hypot(e[0], e[1]);
  const lon = Math.atan2(e[1], e[0]);
  let lat = Math.atan2(e[2], p * (1 - e2)), h = 0;
  for (let i = 0; i < 4; i++) {
    const n = RE / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(e[2], p * (1 - e2 * n / (n + h)));
  }
  return { lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI, h };
}

const RB = RE * (1 - FLATTENING);
/** Height above the WGS-84 ellipsoid (m): radial distance above the ellipsoid surface point at the
 *  same geocentric latitude. Exact on the surface; differs from the normal height by < 1 m in LEO. */
export function altitude(r) {
  const rn = norm(r);
  const s = r[2] / rn, c2 = 1 - s * s;
  return rn - (RE * RB) / Math.sqrt(RB * RB * c2 + RE * RE * s * s);
}

/** Velocity of the co-rotating atmosphere at r (m/s). */
export const airVelocity = (r) => [-OMEGA_E * r[1], OMEGA_E * r[0], 0];

/** Rows: radial, along-track (transverse), cross-track (normal). */
export function rtnBasis(r, v) {
  const rh = unit(r), nh = unit(cross(r, v)), th = cross(nh, rh);
  return [rh, th, nh];
}

/** Local east / north / up unit vectors at inertial position r. */
export function enu(r) {
  const up = unit(r);
  const east = unit(cross([0, 0, 1], up));
  const north = cross(up, east);
  return { east, north, up };
}
