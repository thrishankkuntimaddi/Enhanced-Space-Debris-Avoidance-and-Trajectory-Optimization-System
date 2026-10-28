"""Which catalog is active (live or seed). Deliberately light: json only, no pandas, so the web
app can answer metadata requests without importing the data stack."""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

from src.config import settings as S


def _live_is_usable() -> bool:
    q = S.LIVE_DIR / "quality.json"
    if os.getenv("SENTINEL_DATA", "auto") == "seed" or not (S.LIVE_DIR / "catalog.csv").exists() or not q.exists():
        return False
    try:
        ref = datetime.fromisoformat(json.loads(q.read_text())["reference_epoch"])
    except (ValueError, KeyError, json.JSONDecodeError):
        return False
    return datetime.now(timezone.utc) - ref < timedelta(days=S.LIVE_MAX_AGE_DAYS)


def active_dataset() -> dict:
    """Which catalog the app serves: the auto-refreshed live one when it is fresh, else the seed."""
    if _live_is_usable():
        return {"kind": "live", "catalog": S.LIVE_DIR / "catalog.csv", "quality": S.LIVE_DIR / "quality.json"}
    if not S.CATALOG_CSV.exists():
        from src.data.tle_pipeline import default_sources, run_pipeline   # heavy (pandas): only on first build
        run_pipeline(default_sources())
    return {"kind": "seed", "catalog": S.CATALOG_CSV, "quality": S.ARTIFACTS_DIR / "data_quality.json"}


def active_quality() -> dict:
    ds = active_dataset()
    q = json.loads(ds["quality"].read_text())
    q["dataset"] = ds["kind"]
    return q
