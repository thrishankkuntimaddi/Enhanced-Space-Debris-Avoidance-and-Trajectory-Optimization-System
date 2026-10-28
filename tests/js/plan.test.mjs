// End-to-end planning pipeline without a browser: flight computer -> predicted path -> threats ->
// screening -> launch-window scan -> Sentinel (guarded Double DQN). The browser additionally
// propagates the real catalog with SGP4 in web workers; here the ephemeris holds synthetic threats.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MissionPlan, injectThreats, rng } from '../../src/interface/static/sf/game/plan.js';
import { VEHICLES, SITES } from '../../src/interface/static/sf/physics/vehicles.js';
import { optimizeAscent } from '../../src/interface/static/sf/physics/flight.js';
import { Ephemeris } from '../../src/interface/static/sf/physics/collision.js';
import { DDQNPolicy, planGuarded, counts } from '../../src/interface/static/sf/ai/sentinel.js';

test('pipeline: threats on the nominal path are found, and Sentinel clears them', () => {
  const cfg = { vehicle: VEHICLES.find((v) => v.id === 'falcon9'), site: SITES.SLC40, payloadKg: 8000, targetAltKm: 550,
    targetIncDeg: 53, launchDate: new Date('2025-03-12T06:00:00Z'), slipMax: 600 };
  const plan = new MissionPlan(cfg);
  const opt = optimizeAscent({ ...cfg });
  assert.ok(opt.ok);
  plan.kickDeg = opt.kickDeg;
  const nominal = plan.flightFor(0);
  plan.insertionT = nominal.sim.insertion.t;
  plan.horizon = plan.duration = plan.insertionT + 1.5 * nominal.sim.insertion.el.period;
  const steps = Math.ceil((2 * plan.slipMax + plan.horizon) / 60) + 2;
  plan.epochMs = cfg.launchDate.getTime() - plan.slipMax * 1000;
  plan.eph = new Ephemeris({ epochMs: plan.epochMs, dt: 60, steps, n: 0 });
  const nom = plan.pathFor({ slip: 0, dalt: 0, dv: 0 });
  plan.eph = injectThreats(plan.eph, nom, rng(7), 3, { tA: plan.slipMax + plan.insertionT + 300, tB: plan.slipMax + plan.horizon - 600 });
  assert.ok(plan.eph.n >= 3);

  const res = plan.screenPlan({ slip: 0, dalt: 0, dv: 0 });
  assert.ok(res.summary.red >= 1, `threats should be RED on the nominal path, got ${JSON.stringify(res.summary)}`);
  const rows = plan.conj(res);
  assert.ok(rows[0].miss < 5);

  const pol = new DDQNPolicy(JSON.parse(fs.readFileSync(new URL('../../src/interface/static/sf/data/ddqn_policy.json', import.meta.url))));
  const sc = plan.scenario(600); sc.slipMax = 600;
  const out = planGuarded(sc, pol);
  assert.equal(counts(out.final).red, 0, `Sentinel plan still RED: ${JSON.stringify(out.trace)}`);
  assert.ok(out.screens < 120);

  const curve = plan.blackout(120);
  assert.equal(curve.length, 11);
  assert.ok(curve.some((c) => c.red === 0), 'some launch time in the window is clear');
});
