# src/pipeline/planner.py
"""
End-to-end mission planning:

  catalog (7-day super dataset) -> mission spec -> screening context -> nominal screening
  -> avoidance policy (guarded Double DQN) -> verified final screening -> report + 3D payload
"""
from __future__ import annotations

import base64
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import numpy as np
from sgp4.api import Satrec, SatrecArray

from src.config import settings as S
from src.data.propagation_validation import load_sigma_model
from src.data.tle_pipeline import load_catalog
from src.physics.frames import gmst, to_jd
from src.physics.mission import MissionSpec, ManeuverPlan, get_rocket, maneuver_dv_cost_ms, trajectory, orbit_inclination_deg
from src.rl.env import AvoidanceEnv, Scenario, screen_scenario
from src.rl.policies import GreedyLookahead, GuardedPolicy, NumpyQPolicy
from src.rl.scenarios import make_threats, threat_context
from src.screening.conjunction import build_context, risk_level


@lru_cache(maxsize=1)
def catalog_cached():
    return load_catalog()


@lru_cache(maxsize=1)
def policy_cached():
    path = S.MODELS_DIR / "ddqn_policy.npz"
    if path.exists():
        return GuardedPolicy(NumpyQPolicy(path, "Double DQN"))
    return GreedyLookahead()


def catalog_window():
    cat = catalog_cached()
    ref = cat["epoch"].max().to_pydatetime()
    return ref - timedelta(days=3), ref + timedelta(days=2)


def _conj_table(ctx_parts, combined, plan, spec, limit=15, report_km=25.0):
    rows = []
    for part, ctx in ctx_parts:
        rows += part.conjunctions(ctx, report_km=report_km)
    rows.sort(key=lambda r: (-r["pc"], r["miss_km"]))
    return rows[:limit]


def _b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=np.float32).tobytes()).decode()


def plan_mission(rocket: str, target_alt_km: float, launch_time: datetime, inclination_deg: float | None = None,
                 synthetic_threats: int = 0, slip_allowed_s: float = 600.0, seed: int = 0,
                 save: bool = True) -> dict:
    timings = {}
    t = time.perf_counter()
    cat = catalog_cached()
    timings["catalog_load_s"] = time.perf_counter() - t

    if launch_time.tzinfo is None:
        launch_time = launch_time.replace(tzinfo=timezone.utc)
    spec = MissionSpec(get_rocket(rocket), float(target_alt_km), launch_time, inclination_deg)

    t = time.perf_counter()
    base = build_context(spec, cat, slip_max_s=max(slip_allowed_s, 60.0))
    timings["screening_context_s"] = time.perf_counter() - t

    th_ctx = None
    if synthetic_threats:
        th = make_threats(base, np.random.default_rng(seed), int(synthetic_threats))
        th_ctx = threat_context(base, th)
    sc = Scenario(base, th_ctx, float(slip_allowed_s), "user")

    t = time.perf_counter()
    nominal = screen_scenario(sc, ManeuverPlan())
    timings["nominal_screen_ms"] = (time.perf_counter() - t) * 1000

    env = AvoidanceEnv([base])
    if nominal.red.any() or nominal.amber.any():
        policy = policy_cached()
        t = time.perf_counter()
        res = policy.plan(env, sc)
        timings["optimizer_s"] = time.perf_counter() - t
        final_plan, final, trace = res.plan, res.final, res.trace
        decision = {"policy": policy.name, "fallback_used": res.fallback_used, "screen_calls": res.screen_calls}
    else:
        final_plan, final, trace = ManeuverPlan(), nominal, []
        decision = {"policy": "none needed (nominal plan clear)", "fallback_used": False, "screen_calls": 1}

    parts_ctx = lambda comb: list(zip(comb.parts, [base] + ([th_ctx] if th_ctx is not None else [])))
    before = _conj_table(parts_ctx(nominal), nominal, ManeuverPlan(), spec)
    after = _conj_table(parts_ctx(final), final, final_plan, spec)

    n_red, n_amber = int(final.red.sum()), int(final.amber.sum())
    verdict = ("GO" if not nominal.red.any() and not nominal.amber.any() else
               "GO WITH AVOIDANCE PLAN" if n_red == 0 else "NO-GO: residual high-risk conjunction")
    sm = load_sigma_model()
    with open(S.ARTIFACTS_DIR / "data_quality.json") as f:
        quality = json.load(f)

    report = {
        "id": f"{launch_time:%Y%m%dT%H%M}_{rocket.replace(' ', '')}_{uuid.uuid4().hex[:6]}",
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "verdict": verdict,
        "data": {"source": ", ".join(quality["sources"]), "reference_epoch": quality["reference_epoch"],
                 "window_days": quality["window_days"], "catalog_objects": quality["unique_objects"],
                 "elsets_in_history": quality["elsets_in_history"],
                 "sigma_model": f"sigma(age) = {sm['sigma0_km']} km + {sm['k_km_per_day']} km/day x age"},
        "mission": {"rocket": spec.rocket.name, "launch_site": spec.rocket.launch_site,
                    "site_lat_lon": [spec.rocket.lat_deg, spec.rocket.lon_deg],
                    "target_alt_km": spec.target_alt_km, "inclination_deg": round(orbit_inclination_deg(spec), 3),
                    "launch_azimuth_deg": round(spec.launch_azimuth_deg(), 2),
                    "nominal_launch_utc": launch_time.strftime("%Y-%m-%d %H:%M:%S"),
                    "ascent_s": round(spec.ascent_s, 1), "screened_duration_s": round(spec.duration_s, 1),
                    "thrust_n": spec.rocket.thrust_n, "burn_time_s": spec.rocket.burn_time_s,
                    "slip_allowed_s": slip_allowed_s, "synthetic_threat_events": int(synthetic_threats)},
        "screening": {**base.stats, "synthetic_objects": int(th_ctx.n) if th_ctx is not None else 0,
                      "dt_s": spec.dt_s, "thresholds": {"pc_red": S.PC_RED, "pc_amber": S.PC_AMBER,
                                                        "miss_red_km": S.MISS_RED_KM, "miss_amber_km": S.MISS_AMBER_KM}},
        "nominal": {"red": int(nominal.red.sum()), "amber": int(nominal.amber.sum()),
                    "min_miss_km": round(float(nominal.miss_km.min()), 3), "conjunctions": before},
        "decision": {**decision, "trace": trace,
                     "plan": {**final_plan.as_dict(), "launch_utc": (launch_time + timedelta(seconds=final_plan.slip_s)).strftime("%Y-%m-%d %H:%M:%S"),
                              "dv_cost_ms": round(maneuver_dv_cost_ms(spec, final_plan), 3)}},
        "final": {"red": n_red, "amber": n_amber, "min_miss_km": round(float(final.miss_km.min()), 3),
                  "total_pc": float(1 - np.prod(1 - final.pc)), "conjunctions": after},
        "timings": {k: round(v, 3) for k, v in timings.items()},
    }
    report["viz"] = build_viz(spec, base, th_ctx, final_plan, before, after)
    if save:
        with open(S.REPORTS_DIR / f"{report['id']}.json", "w") as f:
            json.dump(report, f, default=str)
    return report


def build_viz(spec, base, th_ctx, final_plan, before, after, n_cloud=2500, cloud_step_s=60.0):
    """Payload for the three.js scene (TEME km; Earth rotation via GMST)."""
    tau = spec.tau[::3]
    nom, _ = trajectory(spec, ManeuverPlan(), tau)
    fin, _ = trajectory(spec, final_plan, tau)

    # tracks of the objects involved in conjunctions (+-12 min around TCA), from the cached ephemeris
    tracks = {}
    lookup = {int(i): (base, k) for k, i in enumerate(base.ids)}
    if th_ctx is not None:
        lookup.update({int(i): (th_ctx, k) for k, i in enumerate(th_ctx.ids)})
    for row in (before + after)[:24]:
        oid = row["object_id"]
        if oid in tracks or oid not in lookup:
            continue
        ctx, k = lookup[oid]
        g0 = ctx.index_of_slip(0.0)
        j = g0 + int(row["tca_mission_s"] // spec.dt_s)
        lo, hi = max(j - 72, 0), min(j + 72, len(ctx.grid_s))
        tracks[oid] = {"name": row["name"], "type": row["type"], "risk": row["risk"],
                       "t0": float(ctx.grid_s[lo]), "dt": spec.dt_s * 2,
                       "pos": np.round(ctx.pos[k, lo:hi:2], 2).tolist()}

    # moving catalog cloud: a sample of all objects every 60 s over the mission
    cat = catalog_cached()
    rng = np.random.default_rng(0)
    idx = rng.choice(len(cat), size=min(n_cloud, len(cat)), replace=False)
    sub = cat.iloc[idx]
    times = np.arange(0, spec.duration_s + cloud_step_s, cloud_step_s)
    jd0, fr0 = to_jd(spec.launch_time)
    sats = [Satrec.twoline2rv(a, b) for a, b in zip(sub["line1"], sub["line2"])]
    err, r, _ = SatrecArray(sats).sgp4(np.full(len(times), jd0), fr0 + times / 86400.0)
    r[err != 0] = 0.0
    type_code = {"PAYLOAD": 0, "ROCKET BODY": 1, "DEBRIS": 2}
    return {
        "frame": "TEME", "units": "km", "earth_radius_km": S.RE_KM,
        "gmst0_rad": float(gmst(spec.launch_time)), "omega_earth": S.OMEGA_EARTH,
        "tau": tau.tolist(), "ascent_s": spec.ascent_s, "final_slip_s": final_plan.slip_s,
        "nominal": np.round(nom, 2).tolist(), "final": np.round(fin, 2).tolist(),
        "tracks": tracks,
        "cloud": {"n": len(sats), "steps": len(times), "dt": cloud_step_s,
                  "types": [type_code.get(t, 3) for t in sub["object_type"]],
                  "pos_b64": _b64(r.transpose(1, 0, 2))},  # (steps, n, 3)
    }
