# src/data/spacetrack_client.py
"""
Collection layer: pulls element sets from Space-Track.org (authoritative, needs an account)
with CelesTrak as an unauthenticated fallback.

Designed to be run once a day (cron / GitHub Actions). Each run writes a dated snapshot to
inputs/snapshots/, and the pipeline merges every snapshot inside the 7-day window.

Credentials come from the environment, never from the repo:
    export SPACETRACK_USERNAME=...   SPACETRACK_PASSWORD=...

Space-Track usage policy: <30 requests/min and <300/hour; pull the full catalog at most
once per hour. The client enforces a minimum interval between requests.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from src.config import settings as S

SPACETRACK_BASE = "https://www.space-track.org"
CELESTRAK_GP = "https://celestrak.org/NORAD/elements/gp.php"
CELESTRAK_SATCAT = "https://celestrak.org/pub/satcat.csv"


class SpaceTrackClient:
    MIN_INTERVAL_S = 2.5  # stays well under 30 requests/minute

    def __init__(self, username: str | None = None, password: str | None = None, timeout: int = 180):
        self.username = username or os.getenv("SPACETRACK_USERNAME")
        self.password = password or os.getenv("SPACETRACK_PASSWORD")
        self.timeout = timeout
        self.session = requests.Session()
        self._last_request = 0.0

    @property
    def has_credentials(self) -> bool:
        return bool(self.username and self.password)

    def _throttle(self):
        wait = self.MIN_INTERVAL_S - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.monotonic()

    def login(self):
        if not self.has_credentials:
            raise RuntimeError("Set SPACETRACK_USERNAME / SPACETRACK_PASSWORD")
        self._throttle()
        r = self.session.post(f"{SPACETRACK_BASE}/ajaxauth/login",
                              data={"identity": self.username, "password": self.password},
                              timeout=self.timeout)
        r.raise_for_status()
        if "Failed" in r.text:
            raise RuntimeError("Space-Track login failed")

    def query(self, path: str) -> str:
        self._throttle()
        r = self.session.get(f"{SPACETRACK_BASE}/basicspacedata/query/{path}", timeout=self.timeout)
        r.raise_for_status()
        return r.text

    def fetch_gp_latest(self) -> str:
        """Latest elset for every on-orbit object (3LE, includes names)."""
        return self.query("class/gp/decay_date/null-val/epoch/%3Enow-10/orderby/norad_cat_id/format/3le")

    def fetch_gp_history(self, days: int = S.WINDOW_DAYS) -> str:
        """Every elset published in the last `days` days — the raw 7-day history."""
        return self.query(f"class/gp_history/CREATION_DATE/%3Enow-{days}/"
                          f"orderby/NORAD_CAT_ID,EPOCH/format/3le")

    def logout(self):
        try:
            self.session.get(f"{SPACETRACK_BASE}/ajaxauth/logout", timeout=30)
        except requests.RequestException:
            pass


def fetch_celestrak(group: str = "active", timeout: int = 180) -> str:
    r = requests.get(CELESTRAK_GP, params={"GROUP": group, "FORMAT": "tle"}, timeout=timeout)
    r.raise_for_status()
    return r.text


def save_snapshot(text: str, source: str, out_dir: Path = S.SNAPSHOTS_DIR) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M")
    path = out_dir / f"{stamp}_{source}.tle"
    path.write_text(text)
    return path


def collect(history: bool = False, out_dir: Path = S.SNAPSHOTS_DIR) -> Path:
    """One daily collection run. Space-Track if credentials exist, else CelesTrak groups."""
    client = SpaceTrackClient()
    if client.has_credentials:
        client.login()
        try:
            text = client.fetch_gp_history() if history else client.fetch_gp_latest()
        finally:
            client.logout()
        return save_snapshot(text, "spacetrack", out_dir)
    # CelesTrak fallback: active payloads plus the major debris clouds
    parts = [fetch_celestrak(g) for g in ("active", "cosmos-1408-debris", "fengyun-1c-debris",
                                          "iridium-33-debris", "cosmos-2251-debris")]
    return save_snapshot("\n".join(parts), "celestrak", out_dir)


def download_satcat(path: Path = S.DATA_DIR / "satcat.csv") -> Path:
    r = requests.get(CELESTRAK_SATCAT, timeout=300)
    r.raise_for_status()
    path.write_bytes(r.content)
    return path
