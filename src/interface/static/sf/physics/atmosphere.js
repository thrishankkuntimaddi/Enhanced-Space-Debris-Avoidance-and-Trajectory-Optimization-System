// U.S. Standard Atmosphere 1976: exact layer equations to 86 km, tabulated density above
// (log-linear interpolation of the published table to 1000 km).
const R_AIR = 287.05287, GAMMA = 1.4, G0 = 9.80665, R_EARTH_GEOPOT = 6356766;
// geopotential base (m), lapse (K/m), base temperature (K), base pressure (Pa)
const LAYERS = [
  [0, -0.0065, 288.15, 101325.0],
  [11000, 0.0, 216.65, 22632.06],
  [20000, 0.001, 216.65, 5474.889],
  [32000, 0.0028, 228.65, 868.0187],
  [47000, 0.0, 270.65, 110.9063],
  [51000, -0.0028, 270.65, 66.93887],
  [71000, -0.002, 214.65, 3.956420],
  [84852, 0.0, 186.946, 0.3734],
];
// geometric altitude (km), density (kg/m^3)
const HIGH = [[86, 6.958e-6], [100, 5.604e-7], [110, 9.708e-8], [120, 2.222e-8], [130, 8.152e-9],
  [140, 3.831e-9], [150, 2.076e-9], [160, 1.233e-9], [180, 5.194e-10], [200, 2.541e-10],
  [250, 6.073e-11], [300, 1.916e-11], [350, 7.014e-12], [400, 2.803e-12], [450, 1.184e-12],
  [500, 5.215e-13], [600, 1.137e-13], [700, 3.070e-14], [800, 1.136e-14], [900, 5.759e-15], [1000, 3.561e-15]];

/** h: geometric altitude (m). Returns temperature K, pressure Pa, density kg/m^3, speed of sound m/s. */
export function atmosphere(h) {
  if (h < 0) h = 0;
  if (h <= 86000) {
    const H = (R_EARTH_GEOPOT * h) / (R_EARTH_GEOPOT + h);
    let L = LAYERS[0];
    for (const l of LAYERS) if (H >= l[0]) L = l;
    const [hb, lapse, Tb, pb] = L;
    const T = Tb + lapse * (H - hb);
    const p = lapse === 0 ? pb * Math.exp((-G0 * (H - hb)) / (R_AIR * Tb))
      : pb * Math.pow(Tb / T, G0 / (R_AIR * lapse));
    return { T, p, rho: p / (R_AIR * T), a: Math.sqrt(GAMMA * R_AIR * T) };
  }
  const km = h / 1000;
  if (km >= 1000) return { T: 1000, p: 0, rho: 0, a: 0 };
  let i = 0;
  while (HIGH[i + 1][0] < km) i++;
  const [h0, r0] = HIGH[i], [h1, r1] = HIGH[i + 1];
  const rho = Math.exp(Math.log(r0) + (Math.log(r1) - Math.log(r0)) * (km - h0) / (h1 - h0));
  const T = Math.min(186.9 + (km - 86) * 6, 1000);   // thermosphere warms quickly; only used for p
  return { T, p: rho * R_AIR * T, rho, a: Math.sqrt(GAMMA * R_AIR * T) };
}

/** Rocket drag coefficient vs Mach: subsonic plateau, transonic rise, supersonic decay. */
export function dragCoefficient(mach) {
  const pts = [[0, 0.30], [0.6, 0.30], [0.9, 0.42], [1.05, 0.62], [1.2, 0.64], [1.6, 0.55], [2.5, 0.42], [4, 0.33], [8, 0.28]];
  if (mach >= 8) return 0.28;
  let i = 0;
  while (pts[i + 1][0] < mach) i++;
  const [m0, c0] = pts[i], [m1, c1] = pts[i + 1];
  return c0 + (c1 - c0) * (mach - m0) / (m1 - m0);
}
