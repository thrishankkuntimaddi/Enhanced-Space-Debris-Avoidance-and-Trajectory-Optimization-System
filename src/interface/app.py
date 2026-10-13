# src/interface/app.py
"""
SDATOS web service.

  GET  /                      mission console (three.js)
  GET  /evidence              data quality, prediction back-test, training & evaluation results
  GET  /report/<id>           printable mission report
  GET  /healthz               liveness + whether presets are warm
  GET  /api/meta              rockets, valid launch window, presets, data provenance, model card
  POST /api/plan              run the full pipeline for one mission (cached by inputs)
  GET  /api/report/<id>       report JSON
  GET  /artifacts/<file>      committed evidence (figures, metrics JSON)

Built for a small instance (Render free tier, 512 MB): one heavy plan at a time behind a lock,
gzip on responses, identical requests served from a disk cache, demo presets warmed at startup.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from flask import Flask, abort, jsonify, render_template, request, send_from_directory
from flask_compress import Compress

from src.config import settings as S
from src.physics.mission import load_rockets
from src.pipeline.planner import PRESETS, plan_mission_cached, run_preset

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.config["COMPRESS_MIMETYPES"] = ["application/json", "text/html", "text/css", "application/javascript"]
Compress(app)

SAFE_ID = re.compile(r"^[A-Za-z0-9_\-]+$")
WARM = {"done": 0, "total": len(PRESETS)}
_THREAD_LOCK = threading.Lock()
LOCK_FILE = S.OUTPUTS_DIR / ".plan.lock"


@contextmanager
def plan_lock(blocking: bool = True):
    """One heavy computation at a time across ALL threads and worker processes, which keeps
    peak memory bounded on a 512 MB instance whatever the worker count. Yields False when
    blocking=False and the lock is busy."""
    if not _THREAD_LOCK.acquire(blocking=blocking):
        yield False
        return
    try:
        with open(LOCK_FILE, "w") as fh:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
                return
            try:
                yield True
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)
    finally:
        _THREAD_LOCK.release()


def _warm_presets():
    for p in PRESETS:
        try:
            with plan_lock() as ok:
                if ok:
                    run_preset(p)          # served from the disk cache if another worker warmed it
        except Exception as e:  # warming is best-effort; a failure only means a slower first click
            app.logger.warning("preset warm-up failed for %s: %s", p["label"], e)
        WARM["done"] += 1


if os.getenv("SDATOS_WARM", "1") == "1":
    threading.Thread(target=_warm_presets, daemon=True).start()


def catalog_window():
    """Valid launch window from the committed data-quality file: no catalog load needed."""
    q = _artifact("data_quality.json")
    ref = datetime.fromisoformat(q["reference_epoch"])
    return ref - timedelta(days=3), ref + timedelta(days=2)


def _artifact(name):
    p = S.ARTIFACTS_DIR / name
    return json.loads(p.read_text()) if p.exists() else None


@app.get("/")
def console():
    return render_template("console.html")


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "presets_warm": WARM})


@app.get("/evidence")
def evidence():
    return render_template("evidence.html", quality=_artifact("data_quality.json"),
                           validation=_artifact("propagation_validation.json"),
                           evaluation=_artifact("evaluation.json"))


@app.get("/report/<rid>")
def report_page(rid):
    if not SAFE_ID.match(rid):
        abort(404)
    p = S.REPORTS_DIR / f"{rid}.json"
    if not p.exists():
        abort(404)
    r = json.loads(p.read_text())
    r.pop("viz", None)
    return render_template("report.html", r=r)


@app.get("/api/meta")
def meta():
    lo, hi = catalog_window()
    rockets = [{"name": r.name, "site": r.launch_site, "lat": r.lat_deg, "lon": r.lon_deg,
                "orbit": r.orbit_type, "max_alt_km": r.max_alt_km}
               for r in load_rockets() if r.orbit_type != "Interplanetary"]
    ev = _artifact("evaluation.json") or {}
    return jsonify({"rockets": rockets, "presets": PRESETS,
                    "window": {"min": lo.strftime("%Y-%m-%dT%H:%M"), "max": hi.strftime("%Y-%m-%dT%H:%M")},
                    "quality": _artifact("data_quality.json"),
                    "model": ev.get("policies") or {}})


@app.post("/api/plan")
def api_plan():
    d = request.get_json(force=True)
    try:
        launch = datetime.fromisoformat(d["launch_time"]).replace(tzinfo=timezone.utc)
        alt = float(d["target_alt_km"])
        if not 300 <= alt <= 2000:
            raise ValueError("Target altitude must be 300-2000 km (LEO)")
        inc = d.get("inclination_deg")
        inc = float(inc) if inc not in (None, "") else None
        threats = max(0, min(int(d.get("synthetic_threats", 0)), 6))
        slip = max(0.0, min(float(d.get("slip_allowed_s", 600)), 600.0))
        lo, hi = catalog_window()
        if not lo <= launch <= hi:
            raise ValueError(f"Launch time must be inside the TLE validity window {lo:%Y-%m-%d %H:%M} .. {hi:%Y-%m-%d %H:%M} UTC")
        with plan_lock():
            rep = plan_mission_cached(d["rocket"], alt, launch, inc, threats, slip, int(d.get("seed", 0)))
    except (KeyError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(rep)


@app.get("/api/report/<rid>")
def report_json(rid):
    if not SAFE_ID.match(rid) or not (S.REPORTS_DIR / f"{rid}.json").exists():
        abort(404)
    return send_from_directory(S.REPORTS_DIR, f"{rid}.json")


@app.get("/artifacts/<path:name>")
def artifacts(name):
    return send_from_directory(S.ARTIFACTS_DIR, name)


if __name__ == "__main__":
    app.run(debug=False, port=int(os.getenv("PORT", "5000")))
