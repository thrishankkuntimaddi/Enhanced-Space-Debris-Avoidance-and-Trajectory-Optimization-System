// Launch vehicles and launch sites.
//
// Figures are approximate public values (manufacturer user guides, press kits and standard
// references), rounded. Where a solid motor's thrust varies along the burn, the thrust below is
// the burn-average so that propellant / mass-flow / burn time stay mutually consistent:
//   mass flow = thrust_vac / (Isp_vac * g0),  burn time = propellant / mass flow.
// Thrust at altitude follows the exact nozzle relation F(p) = F_vac - (F_vac - F_sl) * p / p0.

export const SITES = {
  MAHIA:   { id: 'MAHIA', name: 'Rocket Lab LC-1, Māhia, New Zealand', lat: -39.2615, lon: 177.8649, alt: 30, branch: 'any' },
  WALLOPS: { id: 'WALLOPS', name: 'Rocket Lab LC-2, Wallops, Virginia', lat: 37.8338, lon: -75.4885, alt: 5, branch: 'north' },
  SLC40:   { id: 'SLC40', name: 'SLC-40, Cape Canaveral, Florida', lat: 28.5618, lon: -80.5772, alt: 5, branch: 'north' },
  LC39A:   { id: 'LC39A', name: 'LC-39A, Kennedy Space Center, Florida', lat: 28.6082, lon: -80.6041, alt: 5, branch: 'north' },
  SLC4E:   { id: 'SLC4E', name: 'SLC-4E, Vandenberg, California', lat: 34.6321, lon: -120.6107, alt: 100, branch: 'south' },
  BAIKONUR:{ id: 'BAIKONUR', name: 'Site 31/6, Baikonur, Kazakhstan', lat: 45.9960, lon: 63.5640, alt: 100, branch: 'north' },
  VOSTOCHNY:{ id: 'VOSTOCHNY', name: 'Site 1S, Vostochny, Russia', lat: 51.8844, lon: 128.3335, alt: 230, branch: 'north' },
  SHAR:    { id: 'SHAR', name: 'First Launch Pad, Sriharikota, India', lat: 13.7199, lon: 80.2304, alt: 5, branch: 'south' },
  KOUROU:  { id: 'KOUROU', name: 'ELA-4, Guiana Space Centre, Kourou', lat: 5.2615, lon: -52.7920, alt: 15, branch: 'north' },
};

const stage = (o) => ({ minThrottle: 1, restartable: false, ullage_s: 0, ...o });

export const VEHICLES = [
  {
    id: 'electron', name: 'Electron', maker: 'Rocket Lab', country: 'NZ / USA',
    blurb: 'Carbon-composite small launcher with electric-pump-fed Rutherford engines and a Curie kick stage that circularises the orbit.',
    sites: ['MAHIA', 'WALLOPS'], diameter: 1.2, qLimit: 45000, gLimit: 6.5,
    payload: { default: 200, max: 300 }, colors: { body: 0x1a1a1f, accent: 0xe8e8ea, engine: 0x666670 },
    fairing: { mass: 50, length: 2.5, diameter: 1.2, sepAlt: 105000 },
    stages: [
      stage({ name: 'Stage 1', engine: '9 × Rutherford', thrustSL: 190e3, thrustVac: 216e3, ispSL: 303, ispVac: 311, prop: 9250, dry: 950, length: 12.1, diameter: 1.2 }),
      stage({ name: 'Stage 2', engine: 'Rutherford Vacuum', thrustSL: 0, thrustVac: 25.8e3, ispSL: 0, ispVac: 343, prop: 2400, dry: 250, length: 2.4, diameter: 1.2, ullage_s: 2 }),
      stage({ name: 'Curie kick stage', engine: 'Curie', thrustSL: 0, thrustVac: 120, ispSL: 0, ispVac: 300, prop: 40, dry: 60, length: 0.6, diameter: 1.1, restartable: true, kick: true }),
    ],
  },
  {
    id: 'falcon9', name: 'Falcon 9', maker: 'SpaceX', country: 'USA',
    blurb: 'Two-stage kerosene/LOX workhorse. Nine Merlin 1D engines throttle down through max-Q; the MVac upper stage restarts for circularisation.',
    sites: ['SLC40', 'LC39A', 'SLC4E'], diameter: 3.66, qLimit: 45000, gLimit: 5.0,
    payload: { default: 8000, max: 22800 }, colors: { body: 0xf4f5f7, accent: 0x15161a, engine: 0x3a3a40 },
    fairing: { mass: 1900, length: 13.1, diameter: 5.2, sepAlt: 110000 },
    stages: [
      stage({ name: 'Stage 1', engine: '9 × Merlin 1D', thrustSL: 7607e3, thrustVac: 8227e3, ispSL: 283, ispVac: 312, prop: 395700, dry: 25600, length: 41.2, diameter: 3.66, minThrottle: 0.57 }),
      stage({ name: 'Stage 2', engine: 'Merlin 1D Vacuum', thrustSL: 0, thrustVac: 981e3, ispSL: 0, ispVac: 348, prop: 92670, dry: 3900, length: 13.8, diameter: 3.66, minThrottle: 0.39, restartable: true, ullage_s: 3 }),
    ],
  },
  {
    id: 'falconheavy', name: 'Falcon Heavy', maker: 'SpaceX', country: 'USA',
    blurb: 'Three Falcon cores. The centre core throttles down at liftoff to save propellant, then runs alone after the side boosters separate.',
    sites: ['LC39A'], diameter: 3.66, qLimit: 45000, gLimit: 5.0, coreThrottleWithBoosters: 0.6,
    payload: { default: 20000, max: 63800 }, colors: { body: 0xf4f5f7, accent: 0x15161a, engine: 0x3a3a40 },
    fairing: { mass: 1900, length: 13.1, diameter: 5.2, sepAlt: 110000 },
    boosters: { count: 2, name: 'Side boosters', engine: '9 × Merlin 1D', thrustSL: 7607e3, thrustVac: 8227e3, ispSL: 283, ispVac: 312, prop: 395700, dry: 22200, length: 44.6, diameter: 3.66, style: 'side' },
    stages: [
      stage({ name: 'Centre core', engine: '9 × Merlin 1D', thrustSL: 7607e3, thrustVac: 8227e3, ispSL: 283, ispVac: 312, prop: 395700, dry: 28000, length: 41.2, diameter: 3.66, minThrottle: 0.57 }),
      stage({ name: 'Stage 2', engine: 'Merlin 1D Vacuum', thrustSL: 0, thrustVac: 981e3, ispSL: 0, ispVac: 348, prop: 92670, dry: 3900, length: 13.8, diameter: 3.66, minThrottle: 0.39, restartable: true, ullage_s: 3 }),
    ],
  },
  {
    id: 'soyuz', name: 'Soyuz-2.1b / Fregat-M', maker: 'RKTs Progress / NPO Lavochkin', country: 'Russia',
    blurb: 'Four strap-on boosters peel away in the famous "Korolev cross". Block I upper stage, then the restartable Fregat finishes the job.',
    sites: ['BAIKONUR', 'VOSTOCHNY'], diameter: 2.95, qLimit: 40000, gLimit: 5.0,
    payload: { default: 4000, max: 8200 }, colors: { body: 0xd9d9cf, accent: 0x5a6a4e, engine: 0x444444 },
    fairing: { mass: 1700, length: 11.4, diameter: 4.1, sepAlt: 105000 },
    boosters: { count: 4, name: 'Blocks B, V, G, D', engine: '4 × RD-107A', thrustSL: 838.5e3, thrustVac: 1021e3, ispSL: 263, ispVac: 320, prop: 39160, dry: 3784, length: 19.6, diameter: 2.68, style: 'cone' },
    stages: [
      stage({ name: 'Core (Block A)', engine: 'RD-108A', thrustSL: 792.5e3, thrustVac: 990e3, ispSL: 257, ispVac: 320, prop: 90100, dry: 6545, length: 27.1, diameter: 2.95 }),
      stage({ name: 'Block I', engine: 'RD-0124', thrustSL: 0, thrustVac: 294.3e3, ispSL: 0, ispVac: 359, prop: 25400, dry: 2355, length: 6.7, diameter: 2.66, ullage_s: 1 }),
      stage({ name: 'Fregat-M', engine: 'S5.92', thrustSL: 0, thrustVac: 19.85e3, ispSL: 0, ispVac: 332, prop: 5350, dry: 930, length: 1.5, diameter: 3.35, restartable: true, ullage_s: 2 }),
    ],
  },
  {
    id: 'pslv', name: 'PSLV-XL', maker: 'ISRO', country: 'India',
    blurb: 'Alternating solid and liquid stages with six strap-ons: four lit on the pad, two air-lit at T+25 s. The PS4 upper stage can restart.',
    sites: ['SHAR'], diameter: 2.8, qLimit: 65000, gLimit: 6.0,
    payload: { default: 1500, max: 3800 }, colors: { body: 0xeeeeea, accent: 0xb84a2b, engine: 0x555555 },
    fairing: { mass: 1150, length: 8.3, diameter: 3.2, sepAlt: 115000 },
    boosters: { count: 6, airLit: 2, airLitAt: 25, name: 'PSOM-XL strap-ons', engine: '6 × PSOM-XL (solid)', thrustSL: 450e3, thrustVac: 500e3, ispSL: 250, ispVac: 276, prop: 12000, dry: 3000, length: 13.5, diameter: 1.0, style: 'side' },
    stages: [
      stage({ name: 'PS1', engine: 'S139 (solid)', solid: true, thrustSL: 3400e3, thrustVac: 3800e3, ispSL: 237, ispVac: 269, prop: 138200, dry: 30200, length: 20.3, diameter: 2.8 }),
      stage({ name: 'PS2', engine: 'Vikas', thrustSL: 0, thrustVac: 799e3, ispSL: 0, ispVac: 293, prop: 42000, dry: 5300, length: 12.8, diameter: 2.8, ullage_s: 1 }),
      stage({ name: 'PS3', engine: 'HPS3 (solid)', solid: true, thrustSL: 0, thrustVac: 240e3, ispSL: 0, ispVac: 295, prop: 7650, dry: 1100, length: 3.6, diameter: 2.0 }),
      stage({ name: 'PS4', engine: '2 × PS4 engines', thrustSL: 0, thrustVac: 14.6e3, ispSL: 0, ispVac: 308, prop: 2500, dry: 920, length: 3.0, diameter: 2.8, restartable: true, ullage_s: 1 }),
    ],
  },
  {
    id: 'ariane64', name: 'Ariane 64', maker: 'ArianeGroup', country: 'Europe',
    blurb: 'Four P120C solid boosters around a hydrogen core. The Vinci upper stage restarts in orbit, which also lets it de-orbit itself.',
    sites: ['KOUROU'], diameter: 5.4, qLimit: 45000, gLimit: 5.0,
    payload: { default: 10000, max: 21650 }, colors: { body: 0xf2f2ef, accent: 0x1d3c78, engine: 0x4a4a4a },
    fairing: { mass: 2400, length: 20, diameter: 5.4, sepAlt: 110000 },
    boosters: { count: 4, name: 'P120C boosters', engine: '4 × P120C (solid)', thrustSL: 2800e3, thrustVac: 3100e3, ispSL: 250, ispVac: 278.5, prop: 142000, dry: 11000, length: 13.5, diameter: 3.4, style: 'side' },
    stages: [
      stage({ name: 'Core (LLPM)', engine: 'Vulcain 2.1', thrustSL: 960e3, thrustVac: 1370e3, ispSL: 318, ispVac: 431, prop: 154000, dry: 15000, length: 30, diameter: 5.4 }),
      stage({ name: 'Upper (ULPM)', engine: 'Vinci', thrustSL: 0, thrustVac: 180e3, ispSL: 0, ispVac: 457, prop: 31000, dry: 5500, length: 11.5, diameter: 5.4, restartable: true, ullage_s: 3 }),
    ],
  },
];

export const vehicleById = (id) => VEHICLES.find((v) => v.id === id);

/** Ideal (vacuum) delta-v per phase for a payload mass: what the rocket equation allows. */
export function deltaVBudget(v, payloadKg) {
  const g0 = 9.80665;
  const upperMass = (from) => v.stages.slice(from).reduce((m, s) => m + s.dry + s.prop, 0);
  const out = [];
  let fairing = v.fairing.mass;
  if (v.boosters) {
    // parallel phase: boosters + core burn together until booster burnout
    const b = v.boosters, core = v.stages[0];
    const thr = v.coreThrottleWithBoosters ?? 1;
    const mdB = b.count * b.thrustVac / (b.ispVac * g0), mdC = thr * core.thrustVac / (core.ispVac * g0);
    const tB = b.prop / (b.thrustVac / (b.ispVac * g0));
    const m0 = b.count * (b.dry + b.prop) + upperMass(0) + payloadKg + fairing;
    const used = (mdB + mdC) * tB;
    const ispEff = (b.count * b.thrustVac + thr * core.thrustVac) / ((mdB + mdC) * g0);
    out.push({ name: b.name + ' + ' + core.name, dv: ispEff * g0 * Math.log(m0 / (m0 - used)) });
    const coreLeft = core.prop - mdC * tB;
    const m1 = upperMass(0) - mdC * tB + payloadKg + fairing;
    out.push({ name: core.name + ' (alone)', dv: core.ispVac * g0 * Math.log(m1 / (m1 - coreLeft)) });
  } else {
    const s = v.stages[0];
    const m0 = upperMass(0) + payloadKg + fairing;
    out.push({ name: s.name, dv: s.ispVac * g0 * Math.log(m0 / (m0 - s.prop)) });
  }
  fairing = 0;   // jettisoned early in upper-stage flight
  for (let i = 1; i < v.stages.length; i++) {
    const s = v.stages[i];
    const m0 = upperMass(i) + payloadKg;
    out.push({ name: s.name, dv: s.ispVac * g0 * Math.log(m0 / (m0 - s.prop)) });
  }
  return { phases: out, total: out.reduce((a, p) => a + p.dv, 0) };
}

/** Liftoff thrust-to-weight ratio (sea level). */
export function liftoffTWR(v, payloadKg) {
  const core = v.stages[0];
  const groundLit = v.boosters ? v.boosters.count - (v.boosters.airLit || 0) : 0;
  const thrust = core.thrustSL * (v.boosters ? (v.coreThrottleWithBoosters ?? 1) : 1)
    + (v.boosters ? groundLit * v.boosters.thrustSL : 0);
  const mass = v.stages.reduce((m, s) => m + s.dry + s.prop, 0) + payloadKg + v.fairing.mass
    + (v.boosters ? v.boosters.count * (v.boosters.dry + v.boosters.prop) : 0);
  return thrust / (mass * 9.80665);
}
