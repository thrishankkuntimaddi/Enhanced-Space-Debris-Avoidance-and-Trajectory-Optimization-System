# src/rl/scenarios.py
"""
Training / evaluation scenarios = real catalog background + injected synthetic threats.

Why inject? Against the real catalog, sub-kilometre conjunctions for a fresh launch are rare
(a few per thousand launches), so an agent trained on real data alone would almost never see
the situations it exists for. We keep the real background (so actions can CREATE new risks,
e.g. raising into the Starlink shell) and add threats engineered to intersect the nominal
trajectory: single crossings and fragmentation-style clouds of fragments.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from src.config import settings as S
from src.data.propagation_validation import load_sigma_model
from src.physics.frames import rtn_basis
from src.physics.mission import MissionSpec, ManeuverPlan, trajectory, load_rockets
from src.screening.conjunction import ScreeningContext, build_context


@dataclass
class Threats:
    pos: np.ndarray       # (K, G, 3) on the context's grid
    ids: np.ndarray
    names: list
    types: list
    sigma_km: np.ndarray
    hbr_km: np.ndarray


def circular_track(p0: np.ndarray, vhat: np.ndarray, t_rel: np.ndarray) -> np.ndarray:
    """Two-body circular orbit passing through p0 at t_rel=0 moving along unit vhat."""
    r = np.linalg.norm(p0)
    w = np.sqrt(S.MU_KM3_S2 / r ** 3)
    e1 = p0 / r
    return r * (np.cos(w * t_rel)[:, None] * e1 + np.sin(w * t_rel)[:, None] * vhat)


def make_threats(ctx: ScreeningContext, rng: np.random.Generator, n_events: int,
                 cloud_prob: float = 0.5, id_start: int = -1) -> Threats:
    spec = ctx.spec
    tau = spec.tau
    p, v = trajectory(spec, ManeuverPlan(), tau)
    sm = load_sigma_model()
    pos, ids, names, types, sig, hbr = [], [], [], [], [], []
    nid = id_start
    lo = np.searchsorted(tau, spec.ascent_s + 120)
    for ev in range(n_events):
        j = int(rng.integers(lo, len(tau) - 30))
        basis = rtn_basis(p[j], v[j])  # rows r, t, n
        alpha = np.radians(rng.uniform(15, 170))        # crossing angle
        cloud = rng.random() < cloud_prob
        n_frag = int(rng.integers(4, 9)) if cloud else 1
        for f in range(n_frag):
            off = np.array([rng.normal(0, 0.3), rng.uniform(-0.9, 0.9), rng.uniform(-0.9, 0.9)])
            if cloud:  # fragments: spread in timing (+-60 s) and position (several km)
                off += rng.normal(0, [1.5, 4.0, 2.0])
            dt_shift = rng.uniform(-60, 60) if cloud else 0.0
            a = alpha + (np.radians(rng.normal(0, 3)) if cloud else 0.0)
            p0 = p[j] + off @ basis
            vhat = np.cos(a) * basis[1] + np.sin(a) * basis[2]
            vhat -= (vhat @ (p0 / np.linalg.norm(p0))) * p0 / np.linalg.norm(p0)
            vhat /= np.linalg.norm(vhat)
            pos.append(circular_track(p0, vhat, ctx.grid_s - (tau[j] + dt_shift)))
            ids.append(nid); nid -= 1
            names.append(f"SYNTH-{'CLOUD' if cloud else 'XING'}-{ev + 1}{chr(65 + f) if cloud else ''}")
            types.append("SYNTHETIC")
            sig.append(sm["sigma0_km"] + sm["k_km_per_day"] * rng.uniform(0.2, 3.0))
            hbr.append(0.010)
    if not pos:
        return Threats(np.zeros((0, len(ctx.grid_s), 3), np.float32), np.zeros(0, int), [], [], np.zeros(0), np.zeros(0))
    return Threats(np.stack(pos).astype(np.float32), np.array(ids), names, types, np.array(sig), np.array(hbr))


def threat_context(base: ScreeningContext, th: Threats) -> ScreeningContext:
    return ScreeningContext(spec=base.spec, slip_grid_s=base.slip_grid_s, grid_s=base.grid_s,
                            ids=th.ids, names=th.names, types=th.types, sigma_km=th.sigma_km,
                            hbr_km=th.hbr_km, pos=th.pos, stats={})


LEO_ROCKETS = ["Electron", "Falcon 1", "PSLV", "Vega", "SSLV", "Firefly Alpha", "Antares",
               "Long March 2F", "Long March 4C", "Nuri", "Astra Rocket 3", "Tianlong-2", "Zhuque-2"]


def sample_mission(rng: np.random.Generator, window_start: datetime, window_end: datetime) -> MissionSpec:
    rockets = {r.name: r for r in load_rockets()}
    rk = rockets[LEO_ROCKETS[int(rng.integers(len(LEO_ROCKETS)))]]
    alt = float(rng.choice([rng.uniform(400, 650), rng.uniform(520, 580)]))  # oversample Starlink shell
    alt = float(min(alt, rk.max_alt_km))
    span = (window_end - window_start).total_seconds()
    t0 = window_start + timedelta(seconds=float(rng.uniform(0, span)))
    t0 = t0.replace(second=0, microsecond=0)
    lat = abs(rk.lat_deg)
    inc = float(rng.choice([np.ceil(lat * 10) / 10, rng.uniform(lat + 1, 98.0)]))
    return MissionSpec(rk, round(alt, 1), t0, inclination_deg=round(inc, 2))


def build_backgrounds(catalog: pd.DataFrame, n: int, seed: int) -> list[ScreeningContext]:
    rng = np.random.default_rng(seed)
    ref = catalog["epoch"].max().to_pydatetime()
    out = []
    for _ in range(n):
        spec = sample_mission(rng, ref - timedelta(days=2), ref + timedelta(days=1))
        out.append(build_context(spec, catalog, slip_max_s=600, keep_km=120))
    return out
