"""
Live catalog refresh: pull today's element sets and rebuild the super dataset in data/live/.

Source order
  1. Space-Track.org `gp` (full public catalog: payloads, rocket bodies, debris) when
     SPACETRACK_USERNAME / SPACETRACK_PASSWORD are set.
  2. CelesTrak public groups (active payloads + the four big debris clouds). No account
     needed, but it is a PARTIAL catalog (most rocket bodies and small debris are missing),
     so the dataset is labelled "celestrak-partial" everywhere it is shown.

Safety rails
  * The new catalog is built in a temporary folder, sanity-checked (minimum object count,
    epochs not in the future), and only then swapped in with a rename. A failed or
    suspicious pull never replaces a good catalog; the app keeps serving the previous one
    (or the committed seed snapshot).
  * Both sources ask clients not to re-download the same data more than every hour or two;
    the refresh interval defaults to 6 h and is never allowed below 2 h.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from src.config import settings as S
from src.data import spacetrack_client as st
from src.data.tle_pipeline import run_pipeline

MIN_OBJECTS = {"spacetrack": 15_000, "celestrak-partial": 5_000}
MIN_INTERVAL_H = 2.0


def fetch_latest() -> tuple[str, str]:
    """Return (tle_text, source_label)."""
    client = st.SpaceTrackClient()
    if client.has_credentials:
        client.login()
        try:
            return client.fetch_gp_latest(), "spacetrack"
        finally:
            client.logout()
    groups = ("active", "cosmos-1408-debris", "fengyun-1c-debris", "iridium-33-debris", "cosmos-2251-debris")
    return "\n".join(_celestrak_group(g) for g in groups), "celestrak-partial"


RAW_CACHE = S.DATA_DIR / "live_raw"
CELESTRAK_REUSE_H = 2.0      # CelesTrak answers 403 to a repeat download of a group inside ~2 h


def _celestrak_group(group: str) -> str:
    """One CelesTrak group, through a raw-text cache: reuse a copy younger than 2 h instead of
    asking again, and fall back to the last good copy (any age) if CelesTrak refuses (403)."""
    RAW_CACHE.mkdir(parents=True, exist_ok=True)
    path = RAW_CACHE / f"celestrak_{group}.tle"
    if path.exists() and time.time() - path.stat().st_mtime < CELESTRAK_REUSE_H * 3600:
        return path.read_text()
    try:
        text = st.fetch_celestrak(group)
    except Exception:
        if path.exists():
            return path.read_text()
        raise
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text)
    tmp.replace(path)
    return text


def last_refresh() -> dict | None:
    p = S.LIVE_DIR / "quality.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return None


def due(interval_h: float) -> bool:
    q = last_refresh()
    if not q or "fetched_utc" not in q:
        return True
    fetched = datetime.fromisoformat(q["fetched_utc"])
    return datetime.now(timezone.utc) - fetched >= timedelta(hours=max(interval_h, MIN_INTERVAL_H))


def refresh(text: str | None = None, source: str | None = None, live_dir: Path = S.LIVE_DIR,
            reference: datetime | str = "fetch") -> dict:
    """Fetch (unless text is given), build, validate, swap in. Returns the new quality report.
    reference: "fetch" (default) uses the fetch time; None uses the newest epoch in the data
    (for replaying an archived snapshot)."""
    t0 = time.time()
    if text is None:
        text, source = fetch_latest()
    source = source or "manual"
    fetched = datetime.now(timezone.utc)

    with tempfile.TemporaryDirectory(dir=S.DATA_DIR) as tmp:
        tmp = Path(tmp)
        raw = tmp / "latest.tle"
        raw.write_text(text)
        # the gp class holds ONE elset per object, so the "window" is just staleness filtering
        # reference = fetch time: an elset with an epoch after the fetch is a pre-launch or
        # predicted set, and the window filter drops it instead of letting it skew the window
        res = run_pipeline([raw], out_dir=tmp / "build", reference=fetched if reference == "fetch" else reference,
                           extra_quality={"source_kind": source, "fetched_utc": fetched.isoformat(),
                                          "partial_catalog": source != "spacetrack"})
        q = res.quality
        q["sources"] = [f"{source} @ {fetched:%Y-%m-%d %H:%M} UTC"]
        n = q["unique_objects"]
        if n < MIN_OBJECTS.get(source, 1):
            raise RuntimeError(f"refusing live catalog: only {n} objects from {source}")
        ref = datetime.fromisoformat(q["reference_epoch"])
        if ref > fetched + timedelta(hours=6):
            raise RuntimeError(f"refusing live catalog: reference epoch {ref} is in the future")
        q["build_s"] = round(time.time() - t0, 1)
        (tmp / "build" / "quality.json").write_text(json.dumps(q, indent=2, default=str))

        # swap: build -> live (rename is atomic on one filesystem)
        old = live_dir.with_name(live_dir.name + ".old")
        if old.exists():
            shutil.rmtree(old)
        if live_dir.exists():
            live_dir.rename(old)
        (tmp / "build").rename(live_dir)
        if old.exists():
            shutil.rmtree(old, ignore_errors=True)
    return q
