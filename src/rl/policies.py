# src/rl/policies.py
"""
Policies that plan an avoidance strategy for a scenario, all behind one interface:
    policy.plan(env, scenario) -> PlanResult

  NoAvoidance    commit the nominal plan (what the legacy system effectively did)
  RandomPolicy   random valid moves (sanity floor)
  GreedyLookahead  one-step lookahead: try every move, keep the best shaped reward
                   (strong, but costs 6 screenings per decision)
  GridSearch     brute-force over a coarse slip x altitude x dv grid (cost-optimal-ish
                 reference, hundreds of screenings)
  NumpyQPolicy   trained (D)DQN, numpy forward pass (1 screening per decision)
  GuardedPolicy  production wrapper: run the learned policy, VERIFY the committed plan by
                 re-screening, and fall back to GreedyLookahead if any RED remains.
"""
from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field

import numpy as np

from src.config import settings as S
from src.physics.mission import ManeuverPlan, maneuver_dv_cost_ms
from src.rl.env import (ACTIONS, N_ACTIONS, AvoidanceEnv, Scenario, apply_action, risk_potential,
                        screen_scenario, terminal_score, valid_mask, W_DV, W_SLIP_MIN, DALT_MAX, DV_MAX)


@dataclass
class PlanResult:
    plan: ManeuverPlan
    actions: list = field(default_factory=list)
    screen_calls: int = 0
    wall_s: float = 0.0
    final: object = None
    initial: object = None
    fallback_used: bool = False
    total_return: float = 0.0
    trace: list = field(default_factory=list)

    def metrics(self, scenario: Scenario) -> dict:
        f = self.final
        return {"safe": bool(not f.red.any()), "clean": bool(not f.red.any() and not f.amber.any()),
                "red_before": int(self.initial.red.sum()), "red_after": int(f.red.sum()),
                "amber_after": int(f.amber.sum()), "dv_ms": maneuver_dv_cost_ms(scenario.base.spec, self.plan),
                "slip_min": abs(self.plan.slip_s) / 60.0, "decisions": len(self.actions),
                "screen_calls": self.screen_calls, "wall_s": self.wall_s,
                "fallback": self.fallback_used, "return": self.total_return}


def plan_cost(sc: Scenario, plan: ManeuverPlan, c) -> float:
    """Same objective the RL agent maximises, as a cost (lower is better)."""
    return (-risk_potential(c) - terminal_score(c) + W_DV * maneuver_dv_cost_ms(sc.base.spec, plan)
            + W_SLIP_MIN * abs(plan.slip_s) / 60.0)


class _Rollout:
    def plan(self, env: AvoidanceEnv, sc: Scenario) -> PlanResult:
        t0 = time.perf_counter()
        calls0 = env.screen_calls
        s = env.reset(sc)
        res = PlanResult(ManeuverPlan(), initial=env.initial)
        done = False
        while not done:
            a = self.choose(env, s)
            s, r, done, info = env.step(a)
            res.actions.append(ACTIONS[a]); res.total_return += r
            res.trace.append({"step": len(res.actions), "action": ACTIONS[a], "reward": round(float(r), 3),
                              "invalid": bool(info.get("invalid")), **env.plan.as_dict(),
                              "red": int(env.cur.red.sum()), "amber": int(env.cur.amber.sum()),
                              "min_miss_km": round(float(env.cur.miss_km.min()), 3) if len(env.cur.miss_km) else None})
        res.plan, res.final = env.plan, env.cur
        res.screen_calls = env.screen_calls - calls0
        res.wall_s = time.perf_counter() - t0
        return res


class NoAvoidance(_Rollout):
    name = "No avoidance"
    def choose(self, env, s): return 0


class RandomPolicy(_Rollout):
    name = "Random"
    def __init__(self, seed=0): self.rng = np.random.default_rng(seed)
    def choose(self, env, s):
        m = env.mask()
        return int(self.rng.choice(np.flatnonzero(m)))


class GreedyLookahead(_Rollout):
    name = "Greedy lookahead"
    def choose(self, env, s):
        best_a, best_r = 0, terminal_score(env.cur)
        for a in range(1, N_ACTIONS):
            p = apply_action(env.sc, env.plan, a)
            if p is None:
                continue
            c = env._screen(p)
            r = (risk_potential(c) - risk_potential(env.cur)
                 - W_DV * (maneuver_dv_cost_ms(env.sc.base.spec, p) - maneuver_dv_cost_ms(env.sc.base.spec, env.plan))
                 - W_SLIP_MIN * (abs(p.slip_s) - abs(env.plan.slip_s)) / 60.0 - 0.02)
            # committing now is worth terminal_score(cur); moving is worth r + terminal_score(c) (myopic)
            if r + terminal_score(c) > best_r + 1e-9:
                best_a, best_r = a, r + terminal_score(c)
        return best_a


class GridSearch:
    name = "Grid search"
    def __init__(self, slips=range(-300, 301, 60), dalts=(-6, -4, -2, 0, 2, 4, 6), dvs=(-2, -1, -0.5, 0, 0.5, 1, 2)):
        self.grid = list(itertools.product(slips, dalts, dvs))

    def plan(self, env: AvoidanceEnv, sc: Scenario) -> PlanResult:
        t0 = time.perf_counter()
        init = screen_scenario(sc, ManeuverPlan())
        best, best_c, best_cost, calls = None, None, np.inf, 1
        for sl, da, dv in self.grid:
            p = ManeuverPlan(float(sl), float(da), float(dv))
            if abs(sl) > sc.slip_allowed_s or abs(da) > DALT_MAX or abs(dv) > DV_MAX:
                continue
            c = screen_scenario(sc, p); calls += 1
            cost = plan_cost(sc, p, c)
            if cost < best_cost:
                best, best_c, best_cost = p, c, cost
        return PlanResult(best, ["GRID"], calls, time.perf_counter() - t0, best_c, init,
                          trace=[{"step": 1, "action": "GRID", **best.as_dict(), "red": int(best_c.red.sum()),
                                  "amber": int(best_c.amber.sum())}])


class NumpyQPolicy(_Rollout):
    """Inference-only (D)DQN: loads the .npz exported by DDQNAgent.export_numpy."""
    def __init__(self, path, name="DDQN"):
        w = np.load(path)
        self.name = name
        self.dueling = bool(w["dueling"])
        self.W = {k.replace("__", "."): w[k] for k in w.files if k != "dueling"}

    def q(self, s: np.ndarray) -> np.ndarray:
        W = self.W
        h = np.maximum(W["body.0.weight"] @ s + W["body.0.bias"], 0)
        h = np.maximum(W["body.2.weight"] @ h + W["body.2.bias"], 0)
        if self.dueling:
            a = W["adv.weight"] @ h + W["adv.bias"]
            return (W["value.weight"] @ h + W["value.bias"]) + a - a.mean()
        return W["head.weight"] @ h + W["head.bias"]

    def choose(self, env, s):
        q = self.q(s)
        q[~env.mask()] = -np.inf
        return int(np.argmax(q))


class GuardedPolicy:
    """Learned policy first; verified by an independent re-screen; greedy fallback on failure."""
    def __init__(self, learned: _Rollout, fallback: _Rollout | None = None):
        self.learned, self.fallback = learned, fallback or GreedyLookahead()
        self.name = f"{learned.name} + guard"

    def plan(self, env: AvoidanceEnv, sc: Scenario) -> PlanResult:
        res = self.learned.plan(env, sc)
        verify = screen_scenario(sc, res.plan); res.screen_calls += 1
        if verify.red.any():
            fb = self.fallback.plan(env, sc)
            fb.screen_calls += res.screen_calls
            fb.wall_s += res.wall_s
            fb.actions = res.actions + ["FALLBACK"] + fb.actions
            fb.trace = res.trace + [{"step": len(res.trace) + 1, "action": "VERIFY_FAILED -> FALLBACK",
                                     **res.plan.as_dict(), "red": int(verify.red.sum()),
                                     "amber": int(verify.amber.sum())}] + fb.trace
            fb.fallback_used = True
            return fb
        return res
