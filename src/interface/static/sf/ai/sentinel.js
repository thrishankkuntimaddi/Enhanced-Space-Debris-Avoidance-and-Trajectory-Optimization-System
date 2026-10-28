// SENTINEL: the trained Double DQN from src/rl, running in the browser.
//
// This is a line-by-line port of src/rl/env.py (state encoding, actions, constraints, shaped
// reward) and src/rl/policies.py (numpy forward pass, greedy lookahead, verification guard).
// Weights come from models/ddqn_policy.npz via `python -m src.cli export-policy`.
// Safety never depends on the network: every plan it proposes is re-screened, and if anything
// is still RED the guard falls back to the exhaustive one-step lookahead.
import { DALT_MAX_KM, DV_MAX_MS, DV_BUDGET_MS, RE_KM, MU_KM, PC_RED, PC_AMBER, MISS_RED_KM, MISS_AMBER_KM } from '../physics/constants.js';

export const ACTIONS = ['COMMIT', 'SLIP_LATER_60S', 'SLIP_EARLIER_60S', 'RAISE_2KM', 'LOWER_2KM', 'PROGRADE_0.5MS', 'RETROGRADE_0.5MS'];
export const ACTION_LABEL = ['Commit plan', 'Slip launch +60 s', 'Slip launch −60 s', 'Raise insertion +2 km', 'Lower insertion −2 km', 'Phasing burn +0.5 m/s', 'Phasing burn −0.5 m/s'];
const TOP_K = 5, SLIP_STEP = 60, DALT_STEP = 2, DV_STEP = 0.5, PROX_KM = 5;
const W_DV = 0.25, W_SLIP_MIN = 0.10, W_STEP = 0.02;

export function dvCost(targetAltKm, plan) {
  const r = RE_KM + targetAltKm;
  return Math.sqrt(MU_KM / r) * Math.abs(plan.dalt) / (2 * r) * 1000 + Math.abs(plan.dv);
}

const isRed = (pc, m) => pc >= PC_RED || m < MISS_RED_KM;
const isAmber = (pc, m) => !isRed(pc, m) && (pc >= PC_AMBER || m < MISS_AMBER_KM);
export function counts(c) {
  let red = 0, amber = 0;
  for (let i = 0; i < c.miss.length; i++) { if (isRed(c.pc[i], c.miss[i])) red++; else if (isAmber(c.pc[i], c.miss[i])) amber++; }
  return { red, amber };
}
export function riskPotential(c) {
  let s = 0;
  for (let i = 0; i < c.miss.length; i++) {
    const p = Math.min(1, Math.max(0, 1 - c.miss[i] / PROX_KM));
    s += p * p + (isRed(c.pc[i], c.miss[i]) ? 2 : 0);
  }
  return -s;
}
export function terminalScore(c) {
  const { red, amber } = counts(c);
  return red ? -2 * Math.min(red, 3) : 2 + (amber ? 0 : 0.5);
}

/** sc: { slipMax, slipAllowed, duration, targetAltKm, screen(plan) -> {miss, tau, relSpeed, rtn, pc} } */
export function encodeState(sc, plan, c, stepsLeft, maxSteps) {
  const sm = Math.max(sc.slipMax, 1);
  const head = [plan.slip / sm, plan.dalt / DALT_MAX_KM, plan.dv / DV_MAX_MS, dvCost(sc.targetAltKm, plan) / DV_BUDGET_MS, sc.slipAllowed / sm, stepsLeft / maxSteps];
  const n = c.miss.length;
  const score = new Float64Array(n);
  for (let i = 0; i < n; i++) score[i] = Math.min(1, Math.max(0, 1 - c.miss[i] / 10)) + 2 * (isRed(c.pc[i], c.miss[i]) ? 1 : 0);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => score[b] - score[a]).slice(0, TOP_K);
  const feats = [];
  for (const i of order) {
    if (!Number.isFinite(c.miss[i]) || c.miss[i] > 10) { feats.push(...new Array(8).fill(0)); continue; }
    const lp = Math.log10(Math.max(c.pc[i], 1e-30));
    const cl = (x) => Math.max(-1, Math.min(1, x));
    feats.push(1 - c.miss[i] / 10, c.tau[i] / sc.duration, cl(c.rtn[3 * i] / 10), cl(c.rtn[3 * i + 1] / 10), cl(c.rtn[3 * i + 2] / 10),
      Math.min(1, Math.max(0, (lp + 12) / 12)), Math.min(c.relSpeed[i] / 16, 1), isRed(c.pc[i], c.miss[i]) ? 1 : 0);
  }
  while (feats.length < TOP_K * 8) feats.push(0);
  const { red, amber } = counts(c);
  return Float32Array.from([...head, ...feats, Math.min(red, 5) / 5, Math.min(amber, 5) / 5]);
}

export function applyAction(sc, plan, a) {
  const p = { ...plan };
  if (a === 1) p.slip += SLIP_STEP; else if (a === 2) p.slip -= SLIP_STEP;
  else if (a === 3) p.dalt += DALT_STEP; else if (a === 4) p.dalt -= DALT_STEP;
  else if (a === 5) p.dv += DV_STEP; else if (a === 6) p.dv -= DV_STEP;
  if (Math.abs(p.slip) > sc.slipAllowed + 1e-6 || Math.abs(p.dalt) > DALT_MAX_KM + 1e-6 || Math.abs(p.dv) > DV_MAX_MS + 1e-6
    || dvCost(sc.targetAltKm, p) > DV_BUDGET_MS) return null;
  return p;
}
const validMask = (sc, plan) => ACTIONS.map((_, a) => a === 0 || applyAction(sc, plan, a) !== null);

function shapedReward(sc, plan, next, cur, cNext) {
  return riskPotential(cNext) - riskPotential(cur) - W_DV * (dvCost(sc.targetAltKm, next) - dvCost(sc.targetAltKm, plan))
    - W_SLIP_MIN * (Math.abs(next.slip) - Math.abs(plan.slip)) / 60 - W_STEP;
}

// ── policies ────────────────────────────────────────────────────────────────
function decodeLayer(L) {
  const bin = atob(L.b64), buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return { shape: L.shape, data: new Float32Array(buf.buffer) };
}

export class DDQNPolicy {
  constructor(json) {
    this.dueling = json.dueling;
    this.W = Object.fromEntries(Object.entries(json.layers).map(([k, v]) => [k, decodeLayer(v)]));
    this.name = 'Double DQN';
  }
  static async load(url) { return new DDQNPolicy(await (await fetch(url)).json()); }
  dense(name, x, relu) {
    const W = this.W[name + '.weight'], b = this.W[name + '.bias'];
    const [o, n] = W.shape, y = new Float32Array(o);
    for (let i = 0; i < o; i++) {
      let s = b.data[i];
      for (let j = 0; j < n; j++) s += W.data[i * n + j] * x[j];
      y[i] = relu && s < 0 ? 0 : s;
    }
    return y;
  }
  q(s) {
    let h = this.dense('body.0', s, true);
    h = this.dense('body.2', h, true);
    if (!this.dueling) return this.dense('head', h, false);
    const a = this.dense('adv', h, false), v = this.dense('value', h, false)[0];
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    return a.map((x) => v + x - mean);
  }
}

/** Roll out a policy on the scenario. choose(state, mask, ctx) -> action. Returns the plan + trace. */
function rollout(sc, choose, maxSteps = 10) {
  let plan = { slip: 0, dalt: 0, dv: 0 };
  let cur = sc.screen(plan);
  const initial = cur;
  const trace = [];
  let screens = 1;
  for (let t = 0; t < maxSteps; t++) {
    const s = encodeState(sc, plan, cur, maxSteps - t, maxSteps);
    const mask = validMask(sc, plan);
    const ctx = { plan, cur, countScreen: () => screens++ };
    const a = choose(s, mask, ctx);
    if (a === 0) { trace.push({ action: ACTIONS[0], label: ACTION_LABEL[0], plan: { ...plan }, ...counts(cur), minMiss: Math.min(...cur.miss) }); break; }
    const next = applyAction(sc, plan, a);
    if (!next) continue;
    const c = sc.screen(next); screens++;
    plan = next; cur = c;
    trace.push({ action: ACTIONS[a], label: ACTION_LABEL[a], plan: { ...plan }, ...counts(cur), minMiss: Math.min(...cur.miss) });
  }
  return { plan, final: cur, initial, trace, screens };
}

export function planWithDDQN(sc, policy) {
  // inference-time loop guard: never step back into a plan already visited (the greedy argmax can
  // otherwise oscillate, e.g. slip +60 / -60, until the step budget runs out)
  const visited = new Set();
  const key = (p) => `${p.slip}|${p.dalt}|${p.dv}`;
  return rollout(sc, (s, mask, ctx) => {
    visited.add(key(ctx.plan));
    const q = policy.q(s);
    let best = 0, bq = -Infinity;
    q.forEach((v, a) => {
      if (!mask[a] || v <= bq) return;
      if (a > 0 && visited.has(key(applyAction(sc, ctx.plan, a)))) return;
      bq = v; best = a;
    });
    return best;
  });
}

/** Same objective the agent maximises, as a cost (lower is better): src/rl/policies.py plan_cost. */
export function planCost(sc, plan, c) {
  return -riskPotential(c) - terminalScore(c) + W_DV * dvCost(sc.targetAltKm, plan) + W_SLIP_MIN * Math.abs(plan.slip) / 60;
}

export function planGreedy(sc) {
  return rollout(sc, (s, mask, ctx) => {
    let bestA = 0, bestR = terminalScore(ctx.cur);
    for (let a = 1; a < ACTIONS.length; a++) {
      if (!mask[a]) continue;
      const p = applyAction(sc, ctx.plan, a);
      const c = sc.screen(p); ctx.countScreen();
      const r = shapedReward(sc, ctx.plan, p, ctx.cur, c) + terminalScore(c);
      if (r > bestR + 1e-9) { bestR = r; bestA = a; }
    }
    return bestA;
  });
}

/** Learned policy first, independently verified, greedy fallback if anything is still RED. */
export function planGuarded(sc, policy) {
  const t0 = performance.now();
  const res = policy ? planWithDDQN(sc, policy) : planGreedy(sc);
  const verify = sc.screen(res.plan); res.screens++;
  res.policy = policy ? 'Double DQN + guard' : 'Greedy lookahead';
  if (counts(verify).red) {
    const fb = planGreedy(sc);
    fb.trace = [...res.trace, { action: 'VERIFY_FAILED', label: 'Verification found RED: fallback to lookahead search', plan: res.plan, ...counts(verify) }, ...fb.trace];
    fb.screens += res.screens; fb.fallback = true; fb.policy = res.policy;
    fb.ms = performance.now() - t0;
    return fb;
  }
  res.final = verify; res.fallback = false;
  // AMBER left: also run the one-step lookahead and keep whichever plan scores better
  if (counts(verify).amber) {
    const g = planGreedy(sc);
    const gv = sc.screen(g.plan);
    if (planCost(sc, g.plan, gv) < planCost(sc, res.plan, verify) - 1e-9) {
      g.trace = [...res.trace, { action: 'POLISH', label: 'AMBER remained: lookahead search found a cleaner plan', plan: res.plan, ...counts(verify) }, ...g.trace];
      g.final = gv; g.screens += res.screens + 1; g.policy = res.policy; g.polished = true; g.fallback = false;
      g.ms = performance.now() - t0;
      return g;
    }
  }
  res.ms = performance.now() - t0;
  return res;
}
