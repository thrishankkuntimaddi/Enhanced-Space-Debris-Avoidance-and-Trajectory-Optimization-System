// Physics tests for the in-browser engine:  node --test tests/js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { gmst } from '../../src/interface/static/sf/physics/time.js';
import { atmosphere } from '../../src/interface/static/sf/physics/atmosphere.js';
import { elements, propagate, rk4Coast, circularSpeed } from '../../src/interface/static/sf/physics/orbit.js';
import { MU, RE, J2 } from '../../src/interface/static/sf/physics/constants.js';
import { VEHICLES, SITES, deltaVBudget } from '../../src/interface/static/sf/physics/vehicles.js';
import { FlightSim, simulateFlight, launchAzimuth } from '../../src/interface/static/sf/physics/flight.js';
import { ncx2cdf2, collisionProbability, Ephemeris, Path, screen } from '../../src/interface/static/sf/physics/collision.js';

const FX = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url)));
const T0 = new Date('2025-03-12T06:00:00Z');
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

test('GMST matches python-sgp4 gstime (the angle that defines TEME)', () => {
  for (const [jd, ref] of FX.gmst) close(gmst(jd), ref, 1e-9, `jd ${jd}`);
});

test('U.S. Standard Atmosphere 1976 reference points', () => {
  close(atmosphere(0).p, 101325, 1); close(atmosphere(0).rho, 1.225, 1e-3);
  close(atmosphere(11019).p, 22632, 5); close(atmosphere(11019).T, 216.65, 0.05);   // 11 km geopotential
  close(atmosphere(30000).rho, 0.01841, 2e-4);
  close(atmosphere(400000).rho, 2.803e-12, 1e-15);
});

test('collision probability equals scipy ncx2.cdf (same model as the Python screener)', () => {
  for (const [miss, sig, hbr, ref] of FX.pc) {
    const pc = collisionProbability(miss, sig, hbr);
    assert.ok(Math.abs(pc - ref) <= Math.max(1e-14, 1e-6 * ref), `miss ${miss}: ${pc} vs ${ref}`);
  }
});

test('collision probability matches Monte Carlo', () => {
  let hits = 0, n = 400000, seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  for (let i = 0; i < n; i++) if (Math.hypot(0.3 + 0.2 * gauss(), 0.2 * gauss()) < 0.05) hits++;
  close(collisionProbability(0.3, 0.2, 0.05), hits / n, 0.0012);
});

test('J2 nodal regression matches the analytic secular rate', () => {
  const a = RE + 500e3, inc = 53 * Math.PI / 180, v = circularSpeed(a);
  const r0 = [a, 0, 0], v0 = [0, v * Math.cos(inc), v * Math.sin(inc)];
  const day = 86400;
  const p = propagate(r0, v0, day, 600, 10);
  const n = p.t.length - 1;
  const el0 = elements(r0, v0), el1 = elements([p.r[3 * n], p.r[3 * n + 1], p.r[3 * n + 2]], [p.v[3 * n], p.v[3 * n + 1], p.v[3 * n + 2]]);
  let dRaan = el1.raan - el0.raan; if (dRaan > Math.PI) dRaan -= 2 * Math.PI;
  const nMean = Math.sqrt(MU / a ** 3);
  const analytic = -1.5 * nMean * J2 * (RE / a) ** 2 * Math.cos(inc) * day;
  close(dRaan, analytic, Math.abs(analytic) * 0.03, 'RAAN drift over one day');
  close(el1.a, el0.a, 15e3, 'semi-major axis stays bounded (osculating J2 oscillation)');
});

test('energy is conserved by the coast integrator (point-mass part)', () => {
  let r = [RE + 700e3, 0, 0], v = [0, 7504, 0];
  const E = (r, v) => (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) / 2 - MU / Math.hypot(...r);
  const e0 = E(r, v);
  for (let i = 0; i < 600; i++) [r, v] = rk4Coast(r, v, 10, 0);
  close(E(r, v), e0, Math.abs(e0) * 2e-3);   // J2 makes osculating energy oscillate slightly
});

test('rotating-Earth launch azimuth: due east from the Cape for i = 28.5 deg', () => {
  const sim = new FlightSim({ vehicle: VEHICLES[1], site: SITES.SLC40, payloadKg: 5000, targetAltKm: 400, targetIncDeg: 28.6, launchDate: T0 });
  close(sim.az.inertialDeg, 90, 5);
  const ssO = launchAzimuth(SITES.SHAR, sim.r, 700, 98.2, 'south');
  assert.ok(ssO.inertialDeg > 180, 'SSO from Sriharikota flies south-west');
});

test('every vehicle reaches its target orbit (altitude within 3 %, inclination within 0.1 deg)', () => {
  const cases = [['electron', 'MAHIA', 500, 45, 200, 8], ['falcon9', 'SLC40', 550, 53, 8000, 9],
    ['falconheavy', 'LC39A', 600, 28.6, 20000, 10], ['soyuz', 'BAIKONUR', 450, 51.6, 4000, 7],
    ['pslv', 'SHAR', 700, 98.2, 1500, 17], ['ariane64', 'KOUROU', 800, 6, 10000, 12]];
  for (const [id, site, alt, inc, pl, kick] of cases) {
    const sim = simulateFlight({ vehicle: VEHICLES.find((v) => v.id === id), site: SITES[site], payloadKg: pl,
      targetAltKm: alt, targetIncDeg: inc, launchDate: T0, kickDeg: kick }, { dt: 0.2 });
    assert.equal(sim.phase, 'ORBIT', `${id}: ${sim.failure?.label} ${sim.failure?.detail}`);
    const el = sim.insertion.el;
    close(el.apoAlt / 1000, alt, alt * 0.03, `${id} apoapsis`);
    close(el.periAlt / 1000, alt, alt * 0.03, `${id} periapsis`);
    close(el.incDeg, inc, 0.1, `${id} inclination`);
    assert.ok(sim.losses.gravity > 600 && sim.losses.gravity < 2000, `${id} gravity loss ${sim.losses.gravity}`);
  }
});

test('delta-v accounting closes: ideal - gravity - drag - steering = change in speed', () => {
  const sim = new FlightSim({ vehicle: VEHICLES[1], site: SITES.SLC40, payloadKg: 8000, targetAltKm: 550, targetIncDeg: 53, launchDate: T0, kickDeg: 9 });
  const v0 = Math.hypot(...sim.v);
  sim.liftoff();
  sim.advance(300, 0.05);
  const L = sim.losses;
  close(L.ideal - L.gravity - L.drag - L.steering, Math.hypot(...sim.v) - v0, 3);
});

test('structural limit: hard manual steering through max-Q breaks the vehicle up', () => {
  const sim = new FlightSim({ vehicle: VEHICLES[1], site: SITES.SLC40, payloadKg: 8000, targetAltKm: 550, targetIncDeg: 53, launchDate: T0, kickDeg: 9 });
  sim.liftoff(); sim.advance(45, 0.05);
  sim.steer.pitch = -25;
  sim.advance(20, 0.05);
  assert.equal(sim.phase, 'FAILED'); assert.equal(sim.failure.key, 'breakup');
});

test('Hermite ephemeris + closed-form TCA match a brute-force search', () => {
  // vehicle and object on crossing circular orbits, sampled every 60 s
  const mk = (incDeg, phase, alt) => {
    const a = RE + alt, v = circularSpeed(a), inc = incDeg * Math.PI / 180;
    return (t) => {
      const u = phase + v / a * t;
      const r = [a * Math.cos(u), a * Math.sin(u) * Math.cos(inc), a * Math.sin(u) * Math.sin(inc)];
      const vv = [-v * Math.sin(u), v * Math.cos(u) * Math.cos(inc), v * Math.cos(u) * Math.sin(inc)];
      return [r.map((x) => x / 1000), vv.map((x) => x / 1000)];
    };
  };
  const veh = mk(53, 0, 550e3), obj = mk(97, 0.0003, 551.2e3);
  const eph = new Ephemeris({ epochMs: 0, dt: 60, steps: 101, n: 1 });
  for (let k = 0; k < 101; k++) { const [r, v] = obj(k * 60); eph.pos.set(r, 3 * k); eph.vel.set(v, 3 * k); eph.ok[k] = 1; }
  eph.meta.push({ id: 1, name: 'X', type: 'DEBRIS', sigma: 0.5, hbr: 0.01 });
  const m = 101, t = new Float64Array(m), r = new Float64Array(3 * m), v = new Float64Array(3 * m);
  for (let j = 0; j < m; j++) { t[j] = j * 60; const [rr, vv] = veh(t[j]); r.set(rr, 3 * j); v.set(vv, 3 * j); }
  const res = screen(eph, new Path(t, r, v));
  let best = Infinity, tb = 0;
  for (let s = 0; s < 6000; s += 0.01) {
    const [a] = veh(s), [b] = obj(s);
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d < best) { best = d; tb = s; }
  }
  close(res.miss[0], best, 0.005, 'miss distance (km)');
  close(res.tca[0], tb, 0.05, 'time of closest approach (s)');
});

test('delta-v budgets are positive and the heavy launchers carry more', () => {
  const f9 = deltaVBudget(VEHICLES[1], 8000).total, el = deltaVBudget(VEHICLES[0], 200).total;
  assert.ok(f9 > 9000 && el > 9000);
});

test('Sentinel AI: browser Double DQN equals the numpy policy used by the Python planner', async () => {
  const { DDQNPolicy } = await import('../../src/interface/static/sf/ai/sentinel.js');
  const json = JSON.parse(fs.readFileSync(new URL('../../src/interface/static/sf/data/ddqn_policy.json', import.meta.url)));
  const pol = new DDQNPolicy(json);
  for (const { s, q } of FX.ddqn) {
    const out = pol.q(Float32Array.from(s));
    q.forEach((v, a) => close(out[a], v, 1e-4, `action ${a}`));
  }
});
