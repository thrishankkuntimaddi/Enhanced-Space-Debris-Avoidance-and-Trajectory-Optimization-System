// Julian dates and Greenwich mean sidereal time (IAU-82, the same formula SGP4 uses for TEME).
import { DEG, TWO_PI } from './constants.js';

export function julian(date) {            // Date -> Julian date (UTC treated as UT1, |dUT1| < 1 s)
  return date.getTime() / 86400000 + 2440587.5;
}

export function gmst(jd) {
  const t = (jd - 2451545.0) / 36525.0;
  let s = -6.2e-6 * t * t * t + 0.093104 * t * t + (876600.0 * 3600 + 8640184.812866) * t + 67310.54841;
  let g = ((s * DEG) / 240.0) % TWO_PI;
  return g < 0 ? g + TWO_PI : g;
}

export const addSeconds = (date, s) => new Date(date.getTime() + s * 1000);
export const fmtUTC = (d) => d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
