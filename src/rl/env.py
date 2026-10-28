# src/rl/env.py
"""
Collision-avoidance planning as an MDP.

  state  : current plan (slip, altitude offset, phasing dv, fuel used, window, steps left)
           + the K most dangerous conjunctions under that plan (proximity, time-to-TCA,
             RTN miss vector, log Pc, relative speed, RED flag) + RED/AMBER counts
  actions: COMMIT | slip +/-60 s | insertion altitude +/-2 km | phasing burn +/-0.5 m/s
  reward : potential-based shaping on a risk potential  Phi = -sum_i [clip(1-miss_i/5km)^2 + 2*RED_i]
           (Ng et al. 1999: shaping with a potential difference leaves the optimal policy unchanged)
           minus delta-v cost (0.25 / m/s), schedule cost (0.1 / min of slip), 0.02 per step,
           plus a terminal score: +2 if no RED (+0.5 more if no AMBER), else -2 per RED.

Every step re-screens the plan against the cached ephemeris (~15 ms), so the agent always
acts on physically consistent numbers, never on a learned surrogate.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np

from src.config import settings as S
from src.physics.mission import ManeuverPlan, maneuver_dv_cost_ms
from src.rl.scenarios import Threats, make_threats, threat_context
from src.screening.conjunction import ScreeningContext, Screening, screen

ACTIONS = ["COMMIT", "SLIP_LATER_60S", "SLIP_EARLIER_60S", "RAISE_2KM", "LOWER_2KM",
           "PROGRADE_0.5MS", "RETROGRADE_0.5MS"]
N_ACTIONS = len(ACTIONS)
TOP_K = 5
STATE_DIM = 6 + TOP_K * 8 + 2

SLIP_STEP, DALT_STEP, DV_STEP = 60.0, 2.0, 0.5
DALT_MAX, DV_MAX, DV_BUDGET = S.DALT_MAX_KM, S.DV_MAX_MS, S.DV_BUDGET_MS
PROX_KM = 5.0
W_DV, W_SLIP_MIN, W_STEP = 0.25, 0.10, 0.02


@dataclass
class Scenario:
    base: ScreeningContext
    threats: ScreeningContext | None
    slip_allowed_s: float
    label: str = ""


@dataclass
class Combined:
    miss_km: np.ndarray
    tca_tau_s: np.ndarray
    rel_speed_kms: np.ndarray
    miss_rtn_km: np.ndarray
    pc: np.ndarray
    parts: tuple

    @property
    def red(self):
        return (self.pc >= S.PC_RED) | (self.miss_km < S.MISS_RED_KM)

    @property
    def amber(self):
        return ~self.red & ((self.pc >= S.PC_AMBER) | (self.miss_km < S.MISS_AMBER_KM))


def screen_scenario(sc: Scenario, plan: ManeuverPlan) -> Combined:
    parts = (screen(sc.base, plan),) + ((screen(sc.threats, plan),) if sc.threats is not None else ())
    cat = lambda f: np.concatenate([getattr(p, f) for p in parts])
    return Combined(cat("miss_km"), cat("tca_tau_s"), cat("rel_speed_kms"),
                    np.concatenate([p.miss_rtn_km for p in parts]).reshape(-1, 3), cat("pc"), parts)


def risk_potential(c: Combined) -> float:
    prox = np.clip(1 - c.miss_km / PROX_KM, 0, 1) ** 2
    return -float(prox.sum() + 2.0 * c.red.sum())


def encode_state(sc: Scenario, plan: ManeuverPlan, c: Combined, steps_left: int, max_steps: int) -> np.ndarray:
    spec = sc.base.spec
    slip_max = max(sc.base.slip_grid_s.max(), 1.0)
    head = [plan.slip_s / slip_max, plan.dalt_km / DALT_MAX, plan.dv_ms / DV_MAX,
            maneuver_dv_cost_ms(spec, plan) / DV_BUDGET, sc.slip_allowed_s / slip_max, steps_left / max_steps]
    order = np.argsort(-(np.clip(1 - c.miss_km / 10, 0, 1) + 2 * c.red))[:TOP_K]
    feats = []
    for i in order:
        if not np.isfinite(c.miss_km[i]) or c.miss_km[i] > 10:
            feats.append(np.zeros(8)); continue
        lp = np.log10(max(c.pc[i], 1e-30))
        feats.append(np.array([
            1 - c.miss_km[i] / 10, c.tca_tau_s[i] / spec.duration_s,
            *np.clip(c.miss_rtn_km[i] / 10, -1, 1),
            np.clip((lp + 12) / 12, 0, 1), min(c.rel_speed_kms[i] / 16, 1), float(c.red[i])]))
    while len(feats) < TOP_K:
        feats.append(np.zeros(8))
    tail = [min(c.red.sum(), 5) / 5, min(c.amber.sum(), 5) / 5]
    return np.concatenate([head, np.concatenate(feats), tail]).astype(np.float32)


def apply_action(sc: Scenario, plan: ManeuverPlan, a: int) -> ManeuverPlan | None:
    """Return the new plan, or None if the action violates a constraint."""
    p = plan
    if a == 1: p = replace(plan, slip_s=plan.slip_s + SLIP_STEP)
    elif a == 2: p = replace(plan, slip_s=plan.slip_s - SLIP_STEP)
    elif a == 3: p = replace(plan, dalt_km=plan.dalt_km + DALT_STEP)
    elif a == 4: p = replace(plan, dalt_km=plan.dalt_km - DALT_STEP)
    elif a == 5: p = replace(plan, dv_ms=plan.dv_ms + DV_STEP)
    elif a == 6: p = replace(plan, dv_ms=plan.dv_ms - DV_STEP)
    if (abs(p.slip_s) > sc.slip_allowed_s + 1e-6 or abs(p.dalt_km) > DALT_MAX + 1e-6
            or abs(p.dv_ms) > DV_MAX + 1e-6 or maneuver_dv_cost_ms(sc.base.spec, p) > DV_BUDGET):
        return None
    return p


def valid_mask(sc: Scenario, plan: ManeuverPlan) -> np.ndarray:
    return np.array([True] + [apply_action(sc, plan, a) is not None for a in range(1, N_ACTIONS)])


def terminal_score(c: Combined) -> float:
    n_red = int(c.red.sum())
    if n_red:
        return -2.0 * min(n_red, 3)
    return 2.0 + (0.5 if not c.amber.any() else 0.0)


class AvoidanceEnv:
    def __init__(self, backgrounds: list[ScreeningContext], seed: int = 0, max_steps: int = 10,
                 threat_events=(0, 4)):
        self.backgrounds = backgrounds
        self.rng = np.random.default_rng(seed)
        self.max_steps = max_steps
        self.threat_events = threat_events
        self.screen_calls = 0

    def sample_scenario(self) -> Scenario:
        base = self.backgrounds[int(self.rng.integers(len(self.backgrounds)))]
        n = int(self.rng.integers(self.threat_events[0], self.threat_events[1] + 1))
        th = make_threats(base, self.rng, n)
        # 35% of missions have an instantaneous window (e.g. SSO / rendezvous): no slip allowed
        allowed = float(self.rng.choice([0.0, 120.0, 300.0, 600.0], p=[0.35, 0.25, 0.2, 0.2]))
        return Scenario(base, threat_context(base, th) if n else None, allowed)

    def reset(self, scenario: Scenario | None = None) -> np.ndarray:
        self.sc = scenario or self.sample_scenario()
        self.plan = ManeuverPlan()
        self.t = 0
        self.cur = self._screen(self.plan)
        self.initial = self.cur
        return self.state()

    def _screen(self, plan):
        self.screen_calls += 1
        return screen_scenario(self.sc, plan)

    def state(self):
        return encode_state(self.sc, self.plan, self.cur, self.max_steps - self.t, self.max_steps)

    def mask(self):
        return valid_mask(self.sc, self.plan)

    def step(self, a: int):
        spec = self.sc.base.spec
        self.t += 1
        if a == 0:
            return self.state(), terminal_score(self.cur), True, {"committed": True}
        new = apply_action(self.sc, self.plan, a)
        if new is None:
            r, done = -0.2 - W_STEP, self.t >= self.max_steps
            return self.state(), r + (terminal_score(self.cur) if done else 0.0), done, {"invalid": True}
        c = self._screen(new)
        r = (risk_potential(c) - risk_potential(self.cur)
             - W_DV * (maneuver_dv_cost_ms(spec, new) - maneuver_dv_cost_ms(spec, self.plan))
             - W_SLIP_MIN * (abs(new.slip_s) - abs(self.plan.slip_s)) / 60.0
             - W_STEP)
        self.plan, self.cur = new, c
        done = self.t >= self.max_steps
        if done:
            r += terminal_score(c)
        return self.state(), r, done, {}
