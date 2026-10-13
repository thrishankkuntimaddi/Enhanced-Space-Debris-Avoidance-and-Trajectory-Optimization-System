# src/data/tle_pipeline.py
"""
TLE ingestion pipeline: raw snapshots (7 days of pulls) -> validated history -> "super dataset".

Stages
  1. parse      : 2LE/3LE text -> records (strict column-level validation + checksum)
  2. history    : all valid elsets in the window, de-duplicated, ordered per object
  3. catalog    : one row per NORAD ID (latest elset) enriched with features derived
                  from the object's own history (decay rate, maneuver flags, staleness)
  4. quality    : a data-quality report with counts for every rejection reason
"""
from __future__ import annotations

import json
import math
from collections import Counter
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

from src.config import settings as S


@dataclass
class TLERecord:
    norad_id: int
    name: str
    intl_designator: str
    epoch: datetime
    line1: str
    line2: str
    inclination_deg: float
    raan_deg: float
    eccentricity: float
    arg_perigee_deg: float
    mean_anomaly_deg: float
    mean_motion_rev_day: float
    bstar: float
    ndot: float


def tle_checksum(line: str) -> int:
    total = 0
    for ch in line[:68]:
        if ch.isdigit():
            total += int(ch)
        elif ch == "-":
            total += 1
    return total % 10


def parse_epoch(field: str) -> datetime:
    yy = int(field[:2])
    year = 2000 + yy if yy < 57 else 1900 + yy
    doy = float(field[2:])
    return datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=doy - 1)


def _parse_exp(field: str) -> float:
    """TLE implied-decimal exponent field, e.g. ' 13742-2' -> 0.13742e-2."""
    f = field.strip()
    if not f or f in ("00000-0", "00000+0", "+00000-0", "-00000-0"):
        return 0.0
    sign = -1.0 if f[0] == "-" else 1.0
    f = f.lstrip("+-")
    mantissa, exp = f[:-2], f[-2:]
    return sign * float(f"0.{mantissa}") * 10 ** int(exp)


def _alpha5_to_int(s: str) -> int:
    s = s.strip()
    if s and s[0].isalpha():  # Alpha-5 catalog numbers (>= 100000)
        letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"
        return (letters.index(s[0]) + 10) * 10000 + int(s[1:])
    return int(s)


def parse_pair(line1: str, line2: str, name: str = "") -> TLERecord:
    """Parse one elset; raises ValueError with a reason code on any defect."""
    if len(line1) != 69 or len(line2) != 69:
        raise ValueError("bad_length")
    if line1[0] != "1" or line2[0] != "2":
        raise ValueError("bad_line_number")
    if tle_checksum(line1) != int(line1[68]) or tle_checksum(line2) != int(line2[68]):
        raise ValueError("bad_checksum")
    sat1, sat2 = _alpha5_to_int(line1[2:7]), _alpha5_to_int(line2[2:7])
    if sat1 != sat2:
        raise ValueError("id_mismatch")
    ecc = float("0." + line2[26:33].strip())
    n = float(line2[52:63])
    if n <= 0 or not (0 <= ecc < 1):
        raise ValueError("bad_elements")
    return TLERecord(
        norad_id=sat1,
        name=name.strip() or f"NORAD {sat1}",
        intl_designator=line1[9:17].strip(),
        epoch=parse_epoch(line1[18:32]),
        line1=line1,
        line2=line2,
        inclination_deg=float(line2[8:16]),
        raan_deg=float(line2[17:25]),
        eccentricity=ecc,
        arg_perigee_deg=float(line2[34:42]),
        mean_anomaly_deg=float(line2[43:51]),
        mean_motion_rev_day=n,
        bstar=_parse_exp(line1[53:61]),
        ndot=float(line1[33:43]),
    )


def parse_tle_text(lines: Iterable[str], stats: Counter | None = None) -> list[TLERecord]:
    """Parse 2LE or 3LE text. Name lines ('0 NAME' or bare text) attach to the next elset."""
    stats = stats if stats is not None else Counter()
    records: list[TLERecord] = []
    pending_name = ""
    buf = [ln.rstrip("\r\n") for ln in lines if ln.strip() and not ln.startswith("#")]
    i = 0
    while i < len(buf):
        ln = buf[i]
        if ln.startswith("1 ") and i + 1 < len(buf) and buf[i + 1].startswith("2 "):
            stats["elsets_seen"] += 1
            try:
                records.append(parse_pair(ln, buf[i + 1], pending_name))
                stats["parsed_ok"] += 1
            except ValueError as e:
                stats[f"rejected_{e}"] += 1
            pending_name = ""
            i += 2
        elif ln.startswith("1 ") or ln.startswith("2 "):
            stats["rejected_orphan_line"] += 1
            i += 1
        else:
            pending_name = ln[2:] if ln.startswith("0 ") else ln
            i += 1
    return records


# ── Derived orbital features ────────────────────────────────────────────────
def semi_major_axis_km(mean_motion_rev_day: np.ndarray) -> np.ndarray:
    n_rad_s = np.asarray(mean_motion_rev_day) * 2 * np.pi / 86400.0
    return (S.MU_KM3_S2 / n_rad_s ** 2) ** (1 / 3)


def classify_regime(perigee_km, apogee_km, period_min, ecc) -> str:
    if ecc > 0.25:
        return "HEO"
    if apogee_km < 2000:
        return "LEO"
    if 1300 < period_min < 1580 and ecc < 0.05:
        return "GEO"
    return "MEO"


def classify_object(name: str, object_type: str | None = None) -> str:
    if object_type:
        return object_type.upper()
    n = name.upper()
    if n.startswith("NORAD "):
        return "UNKNOWN"
    if " DEB" in n or n.endswith("DEB") or "DEBRIS" in n:
        return "DEBRIS"
    if "R/B" in n or "ROCKET BODY" in n:
        return "ROCKET BODY"
    return "PAYLOAD"


@dataclass
class PipelineResult:
    history: pd.DataFrame
    catalog: pd.DataFrame
    quality: dict


def build_history(records: list[TLERecord], window_days: float, stats: Counter,
                  reference: datetime | None = None) -> pd.DataFrame:
    df = pd.DataFrame([asdict(r) for r in records])
    if df.empty:
        raise ValueError("No valid TLEs found")
    before = len(df)
    df = df.drop_duplicates(subset=["line1", "line2"])
    stats["dropped_exact_duplicates"] += before - len(df)
    before = len(df)
    df = df.drop_duplicates(subset=["norad_id", "epoch"], keep="last")
    stats["dropped_same_epoch_duplicates"] += before - len(df)

    ref = reference or df["epoch"].max()
    lo = ref - timedelta(days=window_days)
    in_window = (df["epoch"] >= lo) & (df["epoch"] <= ref)
    stats["dropped_outside_window"] += int((~in_window).sum())
    df = df[in_window].sort_values(["norad_id", "epoch"]).reset_index(drop=True)

    a = semi_major_axis_km(df["mean_motion_rev_day"].to_numpy())
    df["sma_km"] = a
    df["perigee_km"] = a * (1 - df["eccentricity"]) - S.RE_KM
    df["apogee_km"] = a * (1 + df["eccentricity"]) - S.RE_KM
    df["period_min"] = 1440.0 / df["mean_motion_rev_day"]
    return df


def build_catalog(history: pd.DataFrame, reference: datetime) -> pd.DataFrame:
    """Collapse the history into one row per object (latest elset) + history features."""
    g = history.groupby("norad_id", sort=False)
    latest = g.tail(1).set_index("norad_id")
    first = g.head(1).set_index("norad_id")

    n_tles = g.size()
    span_days = (latest["epoch"] - first["epoch"]).dt.total_seconds() / 86400.0
    # Observed decay rate from the object's own history (km/day); NaN with 1 elset
    da = latest["sma_km"] - first["sma_km"]
    decay_rate = (da / span_days.where(span_days >= 0.5)).rename("sma_rate_km_day")

    # Maneuver detection: any consecutive |Δa| above threshold that drag cannot explain
    hist = history[["norad_id", "sma_km"]].copy()
    hist["d_a"] = g["sma_km"].diff().abs()
    max_jump = hist.groupby("norad_id")["d_a"].max().fillna(0.0)

    cat = latest.copy()
    cat["n_tles_window"] = n_tles
    cat["history_span_days"] = span_days
    cat["sma_rate_km_day"] = decay_rate
    cat["max_sma_jump_km"] = max_jump
    # Threshold scales with orbit size: GTO fits routinely wobble by km in a
    cat["elset_discontinuity"] = max_jump > np.maximum(S.MANEUVER_DA_KM, 1e-4 * cat["sma_km"])
    cat["epoch_age_days"] = (reference - cat["epoch"]).dt.total_seconds() / 86400.0
    cat["stale"] = cat["epoch_age_days"] > S.STALE_AGE_DAYS
    cat["decaying"] = cat["perigee_km"] < 200
    cat["regime"] = [classify_regime(p, ap, pm, e) for p, ap, pm, e in
                     zip(cat["perigee_km"], cat["apogee_km"], cat["period_min"], cat["eccentricity"])]
    cat["object_type"] = [classify_object(n) for n in cat["name"]]
    cat = enrich_with_satcat(cat.reset_index())
    # Only payloads can maneuver; discontinuities on debris / rocket bodies are fit noise
    cat["maneuver_detected"] = cat["elset_discontinuity"] & (cat["object_type"] == "PAYLOAD")
    return cat


SATCAT_TYPES = {"PAY": "PAYLOAD", "R/B": "ROCKET BODY", "DEB": "DEBRIS", "UNK": "UNKNOWN"}
# Object radius (km) by type when SATCAT has no radar cross-section
DEFAULT_RADIUS_KM = {"PAYLOAD": 0.005, "ROCKET BODY": 0.006, "DEBRIS": 0.001, "UNKNOWN": 0.002}
MISSION_RADIUS_KM = 0.005


def enrich_with_satcat(cat: pd.DataFrame, satcat_path: Path | None = None) -> pd.DataFrame:
    """Join SATCAT (names, object type, owner, radar cross-section) onto the catalog.

    The hard-body radius used for collision probability comes from RCS when available
    (r = sqrt(RCS / pi)), otherwise from a per-type default.
    """
    satcat_path = satcat_path or (S.DATA_DIR / "satcat.csv")
    cat["owner"] = ""
    cat["rcs_m2"] = np.nan
    if satcat_path.exists():
        sc = pd.read_csv(satcat_path, usecols=["OBJECT_NAME", "NORAD_CAT_ID", "OBJECT_TYPE", "OWNER", "RCS"],
                         keep_default_na=False, na_values={"RCS": [""]})
        sc = sc.drop_duplicates("NORAD_CAT_ID").set_index("NORAD_CAT_ID")
        m = cat["norad_id"].map
        named = cat["name"].str.startswith("NORAD ")
        cat.loc[named, "name"] = m(sc["OBJECT_NAME"])[named].fillna(cat.loc[named, "name"])
        sc_type = m(sc["OBJECT_TYPE"]).map(SATCAT_TYPES)
        cat["object_type"] = sc_type.fillna(cat["object_type"])
        cat["owner"] = m(sc["OWNER"]).fillna("")
        cat["rcs_m2"] = pd.to_numeric(m(sc["RCS"]), errors="coerce")
    radius = np.sqrt(cat["rcs_m2"] / np.pi) / 1000.0
    cat["radius_km"] = radius.fillna(cat["object_type"].map(DEFAULT_RADIUS_KM)).clip(0.0005, 0.05)
    cat["hbr_km"] = cat["radius_km"] + MISSION_RADIUS_KM
    return cat


def run_pipeline(sources: list[Path], window_days: float = S.WINDOW_DAYS,
                 reference: datetime | None = None, save: bool = True) -> PipelineResult:
    stats: Counter = Counter()
    records: list[TLERecord] = []
    raw_lines = 0
    for src in sources:
        with open(src, "r", errors="replace") as f:
            lines = f.readlines()
        raw_lines += len(lines)
        records.extend(parse_tle_text(lines, stats))

    history = build_history(records, window_days, stats, reference)
    ref = reference or history["epoch"].max()
    catalog = build_catalog(history, ref)

    quality = {
        "sources": [str(Path(s).relative_to(S.PROJECT_ROOT)) if str(s).startswith(str(S.PROJECT_ROOT)) else str(s)
                    for s in sources],
        "raw_lines": raw_lines,
        "window_days": window_days,
        "reference_epoch": ref.isoformat(),
        "window_start": (ref - timedelta(days=window_days)).isoformat(),
        "earliest_epoch_in_window": history["epoch"].min().isoformat(),
        **{k: int(v) for k, v in sorted(stats.items())},
        "elsets_in_history": int(len(history)),
        "unique_objects": int(len(catalog)),
        "mean_elsets_per_object": round(float(catalog["n_tles_window"].mean()), 2),
        "objects_with_history(>=2 elsets)": int((catalog["n_tles_window"] >= 2).sum()),
        "regimes": catalog["regime"].value_counts().to_dict(),
        "object_types": catalog["object_type"].value_counts().to_dict(),
        "stale_objects": int(catalog["stale"].sum()),
        "decaying_objects(perigee<200km)": int(catalog["decaying"].sum()),
        "elset_discontinuities": int(catalog["elset_discontinuity"].sum()),
        "maneuvering_payloads": int(catalog["maneuver_detected"].sum()),
        "epoch_age_days": {
            "median": round(float(catalog["epoch_age_days"].median()), 3),
            "p95": round(float(catalog["epoch_age_days"].quantile(0.95)), 3),
            "max": round(float(catalog["epoch_age_days"].max()), 3),
        },
    }

    if save:
        catalog.to_csv(S.CATALOG_CSV, index=False)
        history.drop(columns=["line1", "line2"]).to_csv(S.HISTORY_CSV, index=False)
        with open(S.CATALOG_TLE, "w") as f:
            for r in catalog.itertuples():
                f.write(f"0 {r.name}\n{r.line1}\n{r.line2}\n")
        with open(S.ARTIFACTS_DIR / "data_quality.json", "w") as f:
            json.dump(quality, f, indent=2, default=str)
    return PipelineResult(history=history, catalog=catalog, quality=quality)


def default_sources() -> list[Path]:
    """Seed snapshot + any daily snapshots pulled by the Space-Track client."""
    snaps = sorted(S.SNAPSHOTS_DIR.glob("*.tle"))
    return ([S.TLE_RAW] if S.TLE_RAW.exists() else []) + snaps


def load_catalog() -> pd.DataFrame:
    """Load the super dataset, building it on first use."""
    if not S.CATALOG_CSV.exists():
        run_pipeline(default_sources())
    cat = pd.read_csv(S.CATALOG_CSV, keep_default_na=False,
                      na_values={c: [""] for c in ("sma_rate_km_day", "rcs_m2", "history_span_days")})
    cat["epoch"] = pd.to_datetime(cat["epoch"], utc=True, format="ISO8601")
    cat["name"] = cat["name"].astype(str)
    return cat
