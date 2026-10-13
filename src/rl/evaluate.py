# src/rl/evaluate.py
"""
Held-out evaluation. Test backgrounds use launch times / rockets the agent never trained on.

    python -m src.rl.evaluate --scenarios 200

Writes artifacts/evaluation.json with, per policy: safe rate (no RED at commit, with a 95%
Wilson interval), clean rate (no RED or AMBER), delta-v, launch slip, objective cost, number of
conjunction screenings needed and wall time. Also reports how often REAL catalog conjunctions
show up for random launches with no injected threats.
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np

from src.config import settings as S
from src.data.tle_pipeline import load_catalog
from src.rl.env import AvoidanceEnv
from src.rl.policies import (NoAvoidance, RandomPolicy, GreedyLookahead, GridSearch, NumpyQPolicy,
                             GuardedPolicy, plan_cost)
from src.rl.scenarios import build_backgrounds

TEST_BG_SEED, TEST_SCENARIO_SEED = 22, 99


def wilson(k: int, n: int, z: float = 1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (round((c - h) / d, 4), round((c + h) / d, 4))


def run(policy, env, scenarios):
    rows = []
    for sc in scenarios:
        res = policy.plan(env, sc)
        m = res.metrics(sc)
        m["cost"] = plan_cost(sc, res.plan, res.final)
        rows.append(m)
    k = sum(r["safe"] for r in rows)
    agg = {
        "n": len(rows),
        "safe_rate": round(k / len(rows), 4), "safe_rate_ci95": wilson(k, len(rows)),
        "clean_rate": round(float(np.mean([r["clean"] for r in rows])), 4),
        "mean_dv_ms": round(float(np.mean([r["dv_ms"] for r in rows])), 3),
        "mean_slip_min": round(float(np.mean([r["slip_min"] for r in rows])), 3),
        "mean_cost": round(float(np.mean([r["cost"] for r in rows])), 3),
        "mean_screen_calls": round(float(np.mean([r["screen_calls"] for r in rows])), 2),
        "mean_wall_ms": round(1000 * float(np.mean([r["wall_s"] for r in rows])), 1),
        "fallback_rate": round(float(np.mean([r["fallback"] for r in rows])), 4),
    }
    return agg, rows


def real_catalog_stats(catalog, n: int, seed: int) -> dict:
    """Random real launches, NO synthetic threats: how often does the real catalog bite?"""
    from src.physics.mission import ManeuverPlan
    from src.screening.conjunction import screen
    bgs = build_backgrounds(catalog, n, seed=seed)
    out = {"missions": n, "with_red": 0, "with_amber": 0, "min_miss_km": [], "closest": []}
    for b in bgs:
        sc = screen(b, ManeuverPlan())
        s = sc.summary()
        out["with_red"] += s["red"] > 0
        out["with_amber"] += s["amber"] > 0
        out["min_miss_km"].append(round(s["min_miss_km"], 3))
        conj = sc.conjunctions(b, report_km=5)
        if conj:
            c = conj[0]
            out["closest"].append({"rocket": b.spec.rocket.name, "alt_km": b.spec.target_alt_km,
                                   "launch": b.spec.launch_time.isoformat(), **{k: c[k] for k in
                                   ("name", "type", "miss_km", "pc", "risk", "tca_utc", "rel_speed_kms")}})
    out["median_min_miss_km"] = float(np.median(out["min_miss_km"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenarios", type=int, default=200)
    ap.add_argument("--grid-subset", type=int, default=80)
    ap.add_argument("--backgrounds", type=int, default=6)
    ap.add_argument("--real-missions", type=int, default=30)
    args = ap.parse_args()
    t0 = time.time()
    catalog = load_catalog()
    bgs = build_backgrounds(catalog, args.backgrounds, seed=TEST_BG_SEED)
    env = AvoidanceEnv(bgs, seed=TEST_SCENARIO_SEED, threat_events=(1, 4))
    scenarios = [env.sample_scenario() for _ in range(args.scenarios)]
    n_red = [int(env.reset(sc) is not None and env.initial.red.sum()) for sc in scenarios]

    ddqn = NumpyQPolicy(S.MODELS_DIR / "ddqn_policy.npz", "Double DQN")
    policies = [NoAvoidance(), RandomPolicy(seed=3), GreedyLookahead(), ddqn,
                GuardedPolicy(ddqn)]
    if (S.MODELS_DIR / "dqn_policy.npz").exists():
        policies.insert(3, NumpyQPolicy(S.MODELS_DIR / "dqn_policy.npz", "DQN (vanilla)"))

    results = {"test_set": {"scenarios": len(scenarios), "backgrounds": args.backgrounds,
                            "scenarios_with_red_at_nominal": int(sum(r > 0 for r in n_red)),
                            "mean_red_at_nominal": round(float(np.mean(n_red)), 3),
                            "missions": [{"rocket": b.spec.rocket.name, "alt_km": b.spec.target_alt_km,
                                          "inc_deg": b.spec.inclination_deg,
                                          "launch": b.spec.launch_time.isoformat(),
                                          "objects_cached": b.stats["after_proximity_prune"]} for b in bgs]},
               "policies": {}}
    for pol in policies:
        agg, _ = run(pol, env, scenarios)
        results["policies"][pol.name] = agg
        print(f"{pol.name:24s} {agg}", flush=True)

    sub = scenarios[:args.grid_subset]
    gs, _ = run(GridSearch(), env, sub)
    gs["note"] = f"evaluated on the first {len(sub)} scenarios (brute force is slow)"
    results["policies"]["Grid search (subset)"] = gs
    print(f"{'Grid search (subset)':24s} {gs}", flush=True)
    for pol in (GreedyLookahead(), GuardedPolicy(ddqn)):
        agg, _ = run(pol, env, sub)
        results["policies"][f"{pol.name} (same subset)"] = agg

    # Inference latency of the numpy policy
    s = env.reset(scenarios[0])
    t = time.perf_counter()
    for _ in range(2000):
        ddqn.q(s)
    results["ddqn_forward_pass_us"] = round((time.perf_counter() - t) / 2000 * 1e6, 1)

    results["real_catalog"] = real_catalog_stats(catalog, args.real_missions, seed=303)
    print("real catalog:", {k: v for k, v in results["real_catalog"].items() if k != "min_miss_km"}, flush=True)
    results["minutes"] = round((time.time() - t0) / 60, 1)
    with open(S.ARTIFACTS_DIR / "evaluation.json", "w") as f:
        json.dump(results, f, indent=2, default=str)


if __name__ == "__main__":
    main()
