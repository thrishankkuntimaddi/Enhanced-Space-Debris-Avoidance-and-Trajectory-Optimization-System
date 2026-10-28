import gzip
import json
import os
from datetime import datetime, timezone

os.environ["SDATOS_WARM"] = "0"

import pytest

from src.config import settings as S
from src.data import active, live

SEED_TEXT = S.TLE_RAW.read_text().splitlines(keepends=True)


def _sample(n_lines):
    return "".join(SEED_TEXT[:n_lines])


def test_refresh_builds_and_swaps_in(tmp_path):
    live_dir = tmp_path / "live"
    q = live.refresh(text=_sample(3000), source="manual", live_dir=live_dir, reference=None)
    assert (live_dir / "catalog.csv").exists() and (live_dir / "quality.json").exists()
    assert q["source_kind"] == "manual" and q["unique_objects"] > 500
    assert json.loads((live_dir / "quality.json").read_text())["fetched_utc"] == q["fetched_utc"]


def test_suspicious_pull_never_replaces_a_good_catalog(tmp_path):
    live_dir = tmp_path / "live"
    live.refresh(text=_sample(3000), source="manual", live_dir=live_dir, reference=None)
    before = (live_dir / "catalog.csv").read_bytes()
    with pytest.raises(RuntimeError, match="refusing"):     # a full-catalog source returning ~1k objects
        live.refresh(text=_sample(3000), source="spacetrack", live_dir=live_dir, reference=None)
    assert (live_dir / "catalog.csv").read_bytes() == before


def _fake_live(tmp_path, reference):
    d = tmp_path / "live"
    d.mkdir()
    (d / "catalog.csv").write_text("x\n")
    (d / "quality.json").write_text(json.dumps({"reference_epoch": reference.isoformat(), "unique_objects": 1}))
    return d


def test_stale_live_catalog_falls_back_to_seed(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "LIVE_DIR", _fake_live(tmp_path, datetime(2020, 1, 1, tzinfo=timezone.utc)))
    assert active.active_dataset()["kind"] == "seed"


def test_fresh_live_catalog_is_used(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "LIVE_DIR", _fake_live(tmp_path, datetime.now(timezone.utc)))
    assert active.active_dataset()["kind"] == "live"
    monkeypatch.setenv("SENTINEL_DATA", "seed")              # operator override
    assert active.active_dataset()["kind"] == "seed"


def test_presets_follow_the_reference_day():
    from src.pipeline.presets import resolved
    launches = [p["launch"] for p in resolved("2025-03-13T01:58:40+00:00")]
    assert launches == ["2025-03-12T06:00", "2025-03-11T04:30", "2025-03-12T09:00", "2025-03-11T18:00"]


def test_catalog_endpoint_serves_gzipped_tles():
    from src.interface.app import app
    c = app.test_client()
    r = c.get("/api/catalog")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    body = json.loads(gzip.decompress(r.data))
    row = dict(zip(body["fields"], body["rows"][0]))
    assert row["line1"].startswith("1 ") and row["line2"].startswith("2 ")
    assert body["meta"]["objects"] == len(body["rows"]) > 20_000
    assert c.get("/api/catalog", headers={"If-None-Match": r.headers["ETag"]}).status_code == 304


def test_sgp4_check_endpoint():
    from src.interface.app import app
    r = app.test_client().get("/api/sgp4-check?ids=25544&t=2025-03-12T06:00:00Z").get_json()
    pos = r["positions"]["25544"]
    assert pos["error"] == 0 and 6600 < sum(x * x for x in pos["r_km"]) ** 0.5 < 6900
