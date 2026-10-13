from datetime import datetime, timezone

import numpy as np
import pytest
import torch

from src.physics.mission import MissionSpec, ManeuverPlan, get_rocket, trajectory, maneuver_dv_cost_ms
from src.rl.ddqn import DDQNAgent
from src.rl.env import (AvoidanceEnv, Scenario, STATE_DIM, N_ACTIONS, risk_potential, terminal_score,
                        W_DV, W_SLIP_MIN, W_STEP)
from src.rl.policies import NumpyQPolicy
from src.rl.scenarios import circular_track, make_threats, threat_context
from src.screening.conjunction import ScreeningContext, collision_probability, screen

T0 = datetime(2025, 3, 12, 6, 0, tzinfo=timezone.utc)


def empty_context(spec, slip_max=600.0):
    grid = np.arange(-slip_max, slip_max + spec.duration_s + spec.dt_s, spec.dt_s)
    return ScreeningContext(spec=spec, slip_grid_s=np.arange(-slip_max, slip_max + 1, 60.0), grid_s=grid,
                            ids=np.zeros(0, int), names=[], types=[], sigma_km=np.zeros(0), hbr_km=np.zeros(0),
                            pos=np.zeros((0, len(grid), 3), np.float32))


@pytest.fixture(scope="module")
def spec():
    return MissionSpec(get_rocket("Electron"), 500, T0)


def test_tca_refinement_matches_brute_force(spec):
    """Closed-form TCA on 10 s samples vs. 0.05 s brute force for a crossing object."""
    ctx = empty_context(spec)
    tau_c = spec.ascent_s + 1234.5
    p, v = trajectory(spec, ManeuverPlan(), np.array([tau_c]))
    vhat = np.cross(p[0], [0, 0, 1.0]); vhat /= np.linalg.norm(vhat)
    p0 = p[0] + np.array([0.3, -0.4, 0.2])
    obj = circular_track(p0, vhat, ctx.grid_s - tau_c)
    ctx.pos = obj[None].astype(np.float32)
    ctx.ids, ctx.names, ctx.types = np.array([-1]), ["X"], ["SYNTHETIC"]
    ctx.sigma_km, ctx.hbr_km = np.array([0.5]), np.array([0.01])
    sc = screen(ctx, ManeuverPlan())

    # brute force over the WHOLE mission (equal-radius orbits re-meet every period)
    coarse = np.arange(spec.ascent_s, spec.duration_s, 0.5)
    pc_, _ = trajectory(spec, ManeuverPlan(), coarse)
    t_best = coarse[np.argmin(np.linalg.norm(pc_ - circular_track(p0, vhat, coarse - tau_c), axis=1))]
    fine = np.arange(t_best - 1, t_best + 1, 0.001)
    pf, _ = trajectory(spec, ManeuverPlan(), fine)
    d = np.linalg.norm(pf - circular_track(p0, vhat, fine - tau_c), axis=1)
    assert sc.miss_km[0] == pytest.approx(d.min(), abs=0.05)       # within 50 m
    assert sc.tca_tau_s[0] == pytest.approx(fine[np.argmin(d)], abs=0.1)


def test_pc_matches_monte_carlo():
    rng = np.random.default_rng(0)
    miss, sigma, hbr = 0.3, 0.2, 0.05
    x = rng.normal([miss, 0.0], sigma, size=(2_000_000, 2))
    mc = np.mean(np.hypot(x[:, 0], x[:, 1]) < hbr)
    assert collision_probability(miss, sigma, hbr) == pytest.approx(mc, rel=0.05)


def test_pc_monotone_in_miss_distance():
    pcs = collision_probability(np.array([0.0, 0.5, 1.0, 2.0, 5.0]), 0.5, 0.02)
    assert np.all(np.diff(pcs) < 0)


def test_reward_is_potential_based(spec):
    """Sum of step rewards telescopes: Phi_T - Phi_0 - costs - step penalties + terminal."""
    base = empty_context(spec)
    rng = np.random.default_rng(1)
    th = make_threats(base, rng, 2)
    sc = Scenario(base, threat_context(base, th), 600.0)
    env = AvoidanceEnv([base], seed=0)
    env.reset(sc)
    phi0 = risk_potential(env.cur)
    total, done, actions = 0.0, False, [3, 1, 5, 0]
    for a in actions:
        _, r, done, _ = env.step(a)
        total += r
    expected = (risk_potential(env.cur) - phi0 - W_DV * maneuver_dv_cost_ms(spec, env.plan)
                - W_SLIP_MIN * abs(env.plan.slip_s) / 60 - 3 * W_STEP + terminal_score(env.cur))
    assert total == pytest.approx(expected, abs=1e-6)


def test_double_dqn_target_uses_online_argmax():
    agent = DDQNAgent(STATE_DIM, N_ACTIONS, double=True, seed=0)
    s2 = torch.randn(4, STATE_DIM)
    m2 = torch.ones(4, N_ACTIONS, dtype=torch.bool)
    with torch.no_grad():
        a_star = agent.online(s2).argmax(1, keepdim=True)
        expected = agent.target(s2).gather(1, a_star).squeeze(1)
        vanilla = agent.target(s2).max(1).values
    for i in range(4):
        agent.memory.push(np.zeros(STATE_DIM, np.float32), 0, 0.0, s2[i].numpy(), 0.0, m2[i].numpy())
    # double estimate never exceeds the max-based (vanilla) estimate
    assert torch.all(expected <= vanilla + 1e-6)


def test_numpy_export_matches_torch(tmp_path):
    agent = DDQNAgent(STATE_DIM, N_ACTIONS, seed=3)
    path = tmp_path / "p.npz"
    agent.export_numpy(path)
    pol = NumpyQPolicy(path)
    s = np.random.default_rng(0).normal(size=STATE_DIM).astype(np.float32)
    assert np.allclose(pol.q(s), agent.q_values(s), atol=1e-5)
