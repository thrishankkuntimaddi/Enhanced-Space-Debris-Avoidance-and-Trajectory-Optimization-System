# src/data/propagation_validation.py
"""
How good are our predictions? Back-test SGP4 on the 7-day history.

For every object with >= 2 elsets in the window, propagate the OLDER elset forward to the
epoch of the NEWER one and compare against the newer elset (the freshest orbit
determination). The difference, as a function of the prediction horizon, is the empirical
prediction error. We decompose it into radial / along-track / cross-track (RTN), then fit
a per-axis 1-sigma growth model  sigma(dt) = sigma0 + k * dt_days  that the conjunction
screener uses as the debris covariance when computing probability of collision.
"""
from __future__ import annotations

import json
from datetime import datetime

import numpy as np
import pandas as pd
from sgp4.api import Satrec, jday

from src.config import settings as S

HORIZON_BINS_H = [0, 6, 12, 24, 48, 96, 168]


def _jd(dt: datetime):
    return jday(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second + dt.microsecond * 1e-6)


def rtn_components(dr: np.ndarray, r: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Project error vectors dr (N,3) onto the RTN frame of reference states (r, v)."""
    rh = r / np.linalg.norm(r, axis=1, keepdims=True)
    h = np.cross(r, v)
    nh = h / np.linalg.norm(h, axis=1, keepdims=True)
    th = np.cross(nh, rh)
    return np.stack([(dr * rh).sum(1), (dr * th).sum(1), (dr * nh).sum(1)], axis=1)


def backtest(history_lines: pd.DataFrame, exclude_ids: set[int] | None = None) -> pd.DataFrame:
    """history_lines: columns norad_id, epoch, line1, line2, regime (sorted by norad, epoch)."""
    rows = []
    exclude_ids = exclude_ids or set()
    for nid, grp in history_lines.groupby("norad_id", sort=False):
        if len(grp) < 2 or nid in exclude_ids:
            continue
        recs = grp.to_dict("records")
        for older, newer in zip(recs[:-1], recs[1:]):
            dt_h = (newer["epoch"] - older["epoch"]).total_seconds() / 3600.0
            if dt_h < 0.5:
                continue  # same pass re-fit, not a prediction
            s_old = Satrec.twoline2rv(older["line1"], older["line2"])
            s_new = Satrec.twoline2rv(newer["line1"], newer["line2"])
            jd, fr = _jd(newer["epoch"].to_pydatetime())
            e1, r1, _ = s_old.sgp4(jd, fr)
            e2, r2, v2 = s_new.sgp4(jd, fr)
            if e1 or e2:
                continue
            rows.append((nid, older["regime"], dt_h, *r1, *r2, *v2))
    cols = ["norad_id", "regime", "horizon_h", "px", "py", "pz", "rx", "ry", "rz", "vx", "vy", "vz"]
    df = pd.DataFrame(rows, columns=cols)
    pred, ref = df[["px", "py", "pz"]].to_numpy(), df[["rx", "ry", "rz"]].to_numpy()
    rtn = rtn_components(pred - ref, ref, df[["vx", "vy", "vz"]].to_numpy())
    df["err_km"] = np.linalg.norm(pred - ref, axis=1)
    df["err_r_km"], df["err_t_km"], df["err_n_km"] = rtn[:, 0], rtn[:, 1], rtn[:, 2]
    return df.drop(columns=cols[3:])


def summarize(bt: pd.DataFrame) -> dict:
    bt = bt.copy()
    bt["bin"] = pd.cut(bt["horizon_h"], HORIZON_BINS_H)
    out = {"pairs": int(len(bt)), "by_regime": {}}
    for regime, g in [("ALL", bt)] + list(bt.groupby("regime")):
        rows = []
        for b, gb in g.groupby("bin", observed=True):
            if len(gb) < 20:
                continue
            rows.append({
                "horizon_h": f"{int(b.left)}-{int(b.right)}",
                "n": int(len(gb)),
                "median_km": round(float(gb["err_km"].median()), 3),
                "p90_km": round(float(gb["err_km"].quantile(0.9)), 3),
                "p95_km": round(float(gb["err_km"].quantile(0.95)), 3),
                "median_abs_radial_km": round(float(gb["err_r_km"].abs().median()), 3),
                "median_abs_along_km": round(float(gb["err_t_km"].abs().median()), 3),
                "median_abs_cross_km": round(float(gb["err_n_km"].abs().median()), 3),
            })
        out["by_regime"][regime] = rows
    return out


def fit_sigma_model(bt: pd.DataFrame, regime: str = "LEO") -> dict:
    """Robust per-axis sigma(dt) = sigma0 + k*dt_days, fitted on binned robust spreads.

    Robust spread = 1.4826 * MAD of each RTN component (insensitive to the few residual
    maneuvers). The isotropic sigma used for Pc is the RMS over the three axes.
    """
    g = bt[bt["regime"] == regime].copy()
    g["bin"] = pd.cut(g["horizon_h"], HORIZON_BINS_H)
    xs, ys = [], []
    for b, gb in g.groupby("bin", observed=True):
        if len(gb) < 50:
            continue
        comps = gb[["err_r_km", "err_t_km", "err_n_km"]].to_numpy()
        mad = 1.4826 * np.median(np.abs(comps - np.median(comps, axis=0)), axis=0)
        xs.append(gb["horizon_h"].median() / 24.0)
        ys.append(float(np.sqrt((mad ** 2).mean())))
    k, s0 = np.polyfit(xs, ys, 1)
    return {"regime": regime, "sigma0_km": round(max(float(s0), 0.05), 4), "k_km_per_day": round(float(k), 4),
            "points": [{"dt_days": round(x, 3), "sigma_axis_km": round(y, 4)} for x, y in zip(xs, ys)]}


def run_validation(history: pd.DataFrame, catalog: pd.DataFrame, save: bool = True) -> dict:
    regime = catalog.set_index("norad_id")["regime"]
    h = history[["norad_id", "epoch", "line1", "line2"]].copy()
    h["regime"] = h["norad_id"].map(regime)
    maneuvering = set(catalog.loc[catalog["elset_discontinuity"], "norad_id"])
    bt = backtest(h, exclude_ids=maneuvering)
    result = {
        "method": "propagate older elset to newer elset epoch with SGP4, compare positions",
        "excluded_objects_with_discontinuities": len(maneuvering),
        **summarize(bt),
        "sigma_model": fit_sigma_model(bt, "LEO"),
    }
    if save:
        with open(S.ARTIFACTS_DIR / "propagation_validation.json", "w") as f:
            json.dump(result, f, indent=2)
        bt.to_csv(S.OUTPUTS_DIR / "propagation_backtest.csv", index=False)
    return result


def load_sigma_model() -> dict:
    p = S.ARTIFACTS_DIR / "propagation_validation.json"
    if p.exists():
        return json.loads(p.read_text())["sigma_model"]
    return {"sigma0_km": 0.3, "k_km_per_day": 0.5}  # conservative default before first run
