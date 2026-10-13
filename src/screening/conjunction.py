# src/screening/conjunction.py
"""
Conjunction screening: vehicle trajectory vs. the whole catalog.

Coarse-to-fine design (each stage is cheap and removes most of the work for the next):
  1. Apogee/perigee filter  - drop objects whose altitude band can never overlap the
                              vehicle's band (Hoots-style filter, no propagation needed).
  2. Vectorized SGP4        - propagate survivors in chunks on a 10 s grid that covers every
                              launch slip the optimizer may choose (SatrecArray, C speed).
  3. Proximity prune        - keep only objects that come within `keep_km` of ANY candidate
                              plan (all slips) -> a few hundred objects, cached in memory.
  4. TCA refinement         - between ephemeris samples relative motion is ~linear, so the
                              time & distance of closest approach are solved in closed form.
  5. Probability (Pc)       - 2-D isotropic Gaussian in the encounter plane: Pc is the
                              non-central chi-square CDF at (HBR/sigma)^2 (exact for this model).
                              sigma grows with each elset's age using the back-tested model.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta

import numpy as np
import pandas as pd
from scipy.stats import ncx2
from sgp4.api import Satrec, SatrecArray

from src.config import settings as S
from src.data.propagation_validation import load_sigma_model
from src.physics.frames import to_jd
from src.physics.mission import MissionSpec, ManeuverPlan, trajectory


@dataclass
class ScreeningContext:
    spec: MissionSpec
    slip_grid_s: np.ndarray            # slips the optimizer is allowed to choose
    grid_s: np.ndarray                 # absolute time grid (s from nominal launch)
    ids: np.ndarray                    # object ids (NORAD, or negative for synthetic threats)
    names: list
    types: list
    sigma_km: np.ndarray               # per-object 1-sigma at screening time
    hbr_km: np.ndarray                 # combined hard-body radius
    pos: np.ndarray                    # (N, G, 3) float32 TEME km
    stats: dict = field(default_factory=dict)

    @property
    def n(self):
        return len(self.ids)

    def index_of_slip(self, slip_s: float) -> int:
        return int(round((slip_s - self.grid_s[0]) / self.spec.dt_s))


MAX_REL_SPEED_KMS = 16.0  # head-on LEO encounter upper bound


def altitude_band_filter(cat: pd.DataFrame, lo_km: float, hi_km: float, margin_km: float = 50.0):
    return (cat["perigee_km"] <= hi_km + margin_km) & (cat["apogee_km"] >= lo_km - margin_km)


def build_context(spec: MissionSpec, catalog: pd.DataFrame, slip_max_s: float = 600.0,
                  slip_step_s: float = 60.0, dalt_max_km: float = 10.0, keep_km: float = 150.0,
                  chunk: int = 500) -> ScreeningContext:
    dt = spec.dt_s
    slip_grid = np.arange(-slip_max_s, slip_max_s + 1e-9, slip_step_s)
    grid = np.arange(-slip_max_s, slip_max_s + spec.duration_s + dt, dt)
    tau = spec.tau
    stats = {"catalog_objects": int(len(catalog))}

    # 1. altitude-band filter (vehicle spans ~0 km to target+dalt during ascent/orbit)
    band = altitude_band_filter(catalog, 80.0, spec.target_alt_km + dalt_max_km)
    cand = catalog[band].reset_index(drop=True)
    stats["after_altitude_filter"] = int(len(cand))

    # nominal trajectories for every allowed slip (dalt/dv variants stay within keep_km margin)
    plans = [trajectory(spec, ManeuverPlan(slip_s=s))[0].astype(np.float32) for s in slip_grid]
    jd0, fr0 = to_jd(spec.launch_time)
    jd = np.full(len(grid), jd0)
    fr = fr0 + grid / 86400.0

    kept_pos, kept_rows = [], []
    for start in range(0, len(cand), chunk):
        sub = cand.iloc[start:start + chunk]
        sats = [Satrec.twoline2rv(a, b) for a, b in zip(sub["line1"], sub["line2"])]
        err, r, _ = SatrecArray(sats).sgp4(jd, fr)          # 2. vectorized SGP4
        r = r.astype(np.float32)
        del _
        r[err != 0] = np.nan
        best = np.full(len(sub), np.inf, dtype=np.float32)
        for si, s in enumerate(slip_grid):                   # 3. proximity prune
            k = int(round((s - grid[0]) / dt))
            d = np.linalg.norm(r[:, k:k + len(tau), :] - plans[si][None], axis=2)
            best = np.minimum(best, np.nanmin(np.where(np.isnan(d), np.inf, d), axis=1))
        keep = best < keep_km
        kept_pos.append(r[keep])
        kept_rows.append(sub[keep])
    rows = pd.concat(kept_rows) if kept_rows else cand.iloc[:0]
    pos = np.concatenate(kept_pos) if kept_pos else np.zeros((0, len(grid), 3), np.float32)
    stats["after_proximity_prune"] = int(len(rows))

    sm = load_sigma_model()
    age_days = ((spec.launch_time - rows["epoch"]).dt.total_seconds() / 86400.0).clip(lower=0).to_numpy()
    sigma = sm["sigma0_km"] + sm["k_km_per_day"] * age_days
    return ScreeningContext(
        spec=spec, slip_grid_s=slip_grid, grid_s=grid,
        ids=rows["norad_id"].to_numpy(), names=rows["name"].tolist(), types=rows["object_type"].tolist(),
        sigma_km=sigma.astype(float), hbr_km=rows["hbr_km"].to_numpy(dtype=float), pos=pos, stats=stats)


def add_objects(ctx: ScreeningContext, pos: np.ndarray, ids, names, types, sigma_km, hbr_km):
    ctx.pos = np.concatenate([ctx.pos, pos.astype(np.float32)])
    ctx.ids = np.concatenate([ctx.ids, np.asarray(ids)])
    ctx.names = list(ctx.names) + list(names)
    ctx.types = list(ctx.types) + list(types)
    ctx.sigma_km = np.concatenate([ctx.sigma_km, np.asarray(sigma_km, float)])
    ctx.hbr_km = np.concatenate([ctx.hbr_km, np.asarray(hbr_km, float)])


def collision_probability(miss_km, sigma_km, hbr_km):
    """P(|X| < HBR), X ~ N(miss, sigma^2 I_2) in the encounter plane (Rician / ncx2 CDF)."""
    miss_km, sigma_km = np.asarray(miss_km, float), np.asarray(sigma_km, float)
    return ncx2.cdf((np.asarray(hbr_km) / sigma_km) ** 2, df=2, nc=(miss_km / sigma_km) ** 2)


def risk_level(pc, miss_km):
    if pc >= S.PC_RED or miss_km < S.MISS_RED_KM:
        return "RED"
    if pc >= S.PC_AMBER or miss_km < S.MISS_AMBER_KM:
        return "AMBER"
    return "GREEN"


@dataclass
class Screening:
    miss_km: np.ndarray        # per object, closest approach
    tca_tau_s: np.ndarray      # mission-relative time of closest approach
    rel_speed_kms: np.ndarray
    miss_rtn_km: np.ndarray    # (N,3) miss vector in vehicle RTN frame
    pc: np.ndarray
    plan: ManeuverPlan

    def conjunctions(self, ctx: ScreeningContext, report_km: float = 25.0) -> list[dict]:
        out = []
        for i in np.argsort(self.miss_km):
            if self.miss_km[i] > report_km:
                break
            tca = ctx.spec.launch_time + timedelta(seconds=float(self.plan.slip_s + self.tca_tau_s[i]))
            out.append({
                "object_id": int(ctx.ids[i]), "name": ctx.names[i], "type": ctx.types[i],
                "tca_utc": tca.strftime("%Y-%m-%d %H:%M:%S"),
                "tca_mission_s": round(float(self.tca_tau_s[i]), 1),
                "miss_km": round(float(self.miss_km[i]), 3),
                "radial_km": round(float(self.miss_rtn_km[i, 0]), 3),
                "along_km": round(float(self.miss_rtn_km[i, 1]), 3),
                "cross_km": round(float(self.miss_rtn_km[i, 2]), 3),
                "rel_speed_kms": round(float(self.rel_speed_kms[i]), 3),
                "sigma_km": round(float(ctx.sigma_km[i]), 3),
                "pc": float(self.pc[i]),
                "risk": risk_level(self.pc[i], self.miss_km[i]),
            })
        return out

    def summary(self) -> dict:
        lv = [risk_level(p, m) for p, m in zip(self.pc, self.miss_km)]
        return {"red": lv.count("RED"), "amber": lv.count("AMBER"),
                "min_miss_km": float(self.miss_km.min()) if len(self.miss_km) else float("inf"),
                "max_pc": float(self.pc.max()) if len(self.pc) else 0.0,
                "total_pc": float(1 - np.prod(1 - self.pc)) if len(self.pc) else 0.0}


def screen(ctx: ScreeningContext, plan: ManeuverPlan, min_alt_km: float = 80.0) -> Screening:
    """Closest approach of every cached object to the vehicle flying `plan`."""
    spec = ctx.spec
    tau = spec.tau
    p, v = trajectory(spec, plan, tau)
    p = p.astype(np.float32)
    active = np.linalg.norm(p, axis=1) - S.RE_KM > min_alt_km     # ignore the pad/low atmosphere
    k = ctx.index_of_slip(plan.slip_s)
    if ctx.n == 0:
        z = np.zeros(0)
        return Screening(z, z, z, np.zeros((0, 3)), z, plan)
    d = ctx.pos[:, k:k + len(tau), :] - p[None]                     # (N, M, 3) relative position
    dist = np.linalg.norm(d, axis=2)
    dist = np.where(np.isnan(dist) | ~active[None], np.inf, dist)
    j = np.argmin(dist, axis=1)
    N, M = dist.shape
    rows = np.arange(N)

    # Closed-form TCA. The nearest SAMPLE is not necessarily the nearest ENCOUNTER: at 15 km/s
    # relative speed, samples 10 s apart are 150 km apart, and an object can meet us several
    # times. So for every object that could hide an encounter between samples
    # (sampled min < half a step at max relative speed) we solve every segment.
    best_m = dist[rows, j].astype(float)
    best_s = np.zeros(N)
    best_seg = np.clip(j, 0, M - 2)
    best_vec = d[rows, j].astype(float)
    near = np.flatnonzero(best_m < 0.5 * MAX_REL_SPEED_KMS * spec.dt_s)
    if len(near):
        a = d[near, :-1].astype(float)                           # (n, M-1, 3)
        ab = d[near, 1:].astype(float) - a
        sv = np.clip(-(a * ab).sum(2) / np.maximum((ab * ab).sum(2), 1e-12), 0, 1)
        vec = a + sv[..., None] * ab
        m = np.linalg.norm(vec, axis=2)
        m = np.where(np.isfinite(m) & active[:-1][None] & active[1:][None], m, np.inf)
        k = np.argmin(m, axis=1)
        r_ = np.arange(len(near))
        better = m[r_, k] < best_m[near]
        idx = near[better]
        best_m[idx], best_s[idx], best_seg[idx] = m[r_, k][better], sv[r_, k][better], k[better]
        best_vec[idx] = vec[r_, k][better]
    seg = np.clip(best_seg, 0, M - 2)
    rel_v = (d[rows, seg + 1] - d[rows, seg]).astype(float) / spec.dt_s
    tca = tau[seg] + best_s * spec.dt_s
    basis = rtn_from_vehicle(p[seg].astype(float), v[seg])
    miss_rtn = -np.einsum("nij,nj->ni", basis, best_vec)            # object relative to vehicle
    pc = collision_probability(best_m, np.sqrt(ctx.sigma_km ** 2 + S.MISSION_SIGMA_KM ** 2), ctx.hbr_km)
    pc = np.where(np.isfinite(best_m), pc, 0.0)
    return Screening(best_m, tca, np.linalg.norm(rel_v, axis=1), miss_rtn, pc, plan)


def rtn_from_vehicle(r, v):
    from src.physics.frames import rtn_basis
    return rtn_basis(r, v)
