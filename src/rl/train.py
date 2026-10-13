# src/rl/train.py
"""
Train the avoidance agent.

    python -m src.rl.train --episodes 3000                 # Double DQN (production)
    python -m src.rl.train --episodes 3000 --vanilla       # DQN ablation

Every `--eval-every` episodes the greedy policy is scored on a fixed validation set; the best
checkpoint is kept. We also log the overestimation gap = mean max_a Q(s0,a) minus the
discounted return actually obtained, which is what Double DQN is designed to shrink.
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np
import torch

from src.config import settings as S
from src.data.tle_pipeline import load_catalog
from src.rl.ddqn import DDQNAgent
from src.rl.env import AvoidanceEnv, STATE_DIM, N_ACTIONS
from src.rl.policies import NumpyQPolicy
from src.rl.scenarios import build_backgrounds

TRAIN_BG_SEED, VAL_SEED = 11, 7


def evaluate_agent(agent: DDQNAgent, env: AvoidanceEnv, scenarios, gamma: float) -> dict:
    safe, clean, rets, q0s, disc, dvs, calls = [], [], [], [], [], [], []
    from src.physics.mission import maneuver_dv_cost_ms
    for sc in scenarios:
        c0 = env.screen_calls
        s = env.reset(sc)
        q0s.append(float(np.max(np.where(env.mask(), agent.q_values(s), -np.inf))))
        done, ret, g, k = False, 0.0, 0.0, 0
        while not done:
            s, r, done, _ = env.step(agent.act(s, env.mask(), 0.0))
            ret += r; g += (gamma ** k) * r; k += 1
        safe.append(not env.cur.red.any()); clean.append(not env.cur.red.any() and not env.cur.amber.any())
        rets.append(ret); disc.append(g); dvs.append(maneuver_dv_cost_ms(sc.base.spec, env.plan))
        calls.append(env.screen_calls - c0)
    return {"safe_rate": float(np.mean(safe)), "clean_rate": float(np.mean(clean)),
            "mean_return": float(np.mean(rets)), "mean_dv_ms": float(np.mean(dvs)),
            "mean_screen_calls": float(np.mean(calls)),
            "mean_q0": float(np.mean(q0s)), "mean_discounted_return": float(np.mean(disc)),
            "overestimation": float(np.mean(q0s) - np.mean(disc))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=3000)
    ap.add_argument("--backgrounds", type=int, default=12)
    ap.add_argument("--vanilla", action="store_true", help="vanilla DQN target (ablation)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--eval-every", type=int, default=250)
    ap.add_argument("--val-size", type=int, default=80)
    ap.add_argument("--threads", type=int, default=2)
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    name = "dqn" if args.vanilla else "ddqn"

    t0 = time.time()
    catalog = load_catalog()
    bgs = build_backgrounds(catalog, args.backgrounds, seed=TRAIN_BG_SEED)
    print(f"[{name}] built {len(bgs)} backgrounds in {time.time() - t0:.0f}s", flush=True)

    env = AvoidanceEnv(bgs, seed=args.seed)
    val_env = AvoidanceEnv(bgs, seed=VAL_SEED)
    val_set = [val_env.sample_scenario() for _ in range(args.val_size)]

    agent = DDQNAgent(STATE_DIM, N_ACTIONS, double=not args.vanilla, seed=args.seed)
    eps_end, decay_eps = 0.05, int(0.6 * args.episodes)
    log = {"config": vars(args), "episodes": [], "evals": []}
    best = -np.inf
    for ep in range(1, args.episodes + 1):
        eps = max(eps_end, 1.0 - (1.0 - eps_end) * ep / decay_eps)
        s = env.reset()
        done, ret = False, 0.0
        while not done:
            m = env.mask()
            a = agent.act(s, m, eps)
            s2, r, done, _ = env.step(a)
            agent.memory.push(s, a, r, s2, float(done), env.mask())
            agent.learn()
            s, ret = s2, ret + r
        log["episodes"].append({"ep": ep, "return": round(ret, 4), "eps": round(eps, 4),
                                "safe": bool(not env.cur.red.any())})
        if ep % args.eval_every == 0 or ep == args.episodes:
            ev = evaluate_agent(agent, val_env, val_set, agent.gamma)
            ev.update(ep=ep, minutes=round((time.time() - t0) / 60, 2),
                      loss=float(np.mean(agent.losses[-500:])) if agent.losses else None)
            log["evals"].append(ev)
            score = ev["safe_rate"] * 10 + ev["mean_return"]
            if score > best:
                best = score
                agent.save(S.MODELS_DIR / f"{name}_policy.pt")
                agent.export_numpy(S.MODELS_DIR / f"{name}_policy.npz")
                ev["checkpoint"] = True
            print(f"[{name}] ep {ep} eps {eps:.2f} {json.dumps({k: round(v, 3) if isinstance(v, float) else v for k, v in ev.items()})}", flush=True)

    with open(S.ARTIFACTS_DIR / f"training_{name}.json", "w") as f:
        json.dump(log, f)
    print(f"[{name}] done in {(time.time() - t0) / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
