"""
SentinelFlight web service.

  GET  /                      SentinelFlight: the launch & orbit-ops game (physics in the browser)
  GET  /planner               classic mission planner (server-side screening + guarded Double DQN)
  GET  /evidence              data quality, prediction back-test, training & evaluation results
  GET  /report/<id>           printable mission report
  GET  /healthz               liveness, warm-up and live-data status
  GET  /api/meta              rockets, valid launch window, presets, data provenance, model card
  GET  /api/catalog           the active catalog (TLEs + object info) for in-browser SGP4
  GET  /api/sgp4-check        server-side SGP4 positions, used by the game to cross-check its own
  POST /api/plan              run the classic pipeline for one mission (cached by inputs)
  GET  /api/report/<id>       report JSON
  GET  /artifacts/<file>      committed evidence (figures, metrics JSON)

Built for a small instance (Render free tier, 512 MB): one heavy job at a time behind a lock,
gzip on responses, identical requests served from a disk cache, demo presets warmed in the
background, and the live catalog refreshed in the background every few hours.
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import json
import os
import platform
import re
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from flask import Flask, Response, abort, jsonify, render_template, request, send_from_directory
from flask_compress import Compress

try:                                   # POSIX file locks; Windows falls back to in-process locks only
    import fcntl
except ImportError:                    # pragma: no cover
    fcntl = None

from src.config import settings as S
from src.data.active import active_dataset, active_quality
from src.physics.mission import load_rockets
from src.pipeline.presets import PRESETS, resolved as resolved_presets   # light; the planner loads lazily

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
app.config["COMPRESS_MIMETYPES"] = ["application/json", "text/html", "text/css", "application/javascript"]
Compress(app)

MAX_SEED = 99
SAFE_ID = re.compile(r"^[A-Za-z0-9_\-]+$")
WARM = {"done": 0, "total": len(PRESETS), "stage": "not started (first request starts it)"}
LIVE = {"enabled": os.getenv("SENTINEL_LIVE", "0") == "1",
        "interval_h": float(os.getenv("SENTINEL_REFRESH_H", "6")), "stage": "idle"}
STARTED = time.time()
_IMPORT_LOCK = threading.Lock()
_THREAD_LOCK = threading.Lock()
LOCK_FILE = S.OUTPUTS_DIR / ".plan.lock"


def planner():
    """Import the heavy planner (pandas, scipy) once, thread-safely. On a slow CPU the import takes
    tens of seconds; without the lock a second thread can see a half-initialised module."""
    with _IMPORT_LOCK:
        import src.pipeline.planner as P
        return P


@contextmanager
def plan_lock(blocking: bool = True):
    """One heavy computation at a time across ALL threads and worker processes, which keeps
    peak memory bounded on a 512 MB instance whatever the worker count. Yields False when
    blocking=False and the lock is busy."""
    if not _THREAD_LOCK.acquire(blocking=blocking):
        yield False
        return
    try:
        if fcntl is None:              # single-process dev server on Windows: the thread lock is enough
            yield True
            return
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


def _own(lock_name: str):
    """Non-blocking, process-wide ownership of a background duty (one worker does it). Returns the
    open file (keep it referenced for as long as you own the duty) or None."""
    S.OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    fh = open(S.OUTPUTS_DIR / lock_name, "w")
    if fcntl is not None:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fh.close()
            return None
    return fh


# ── Background duties: live-data refresh, then preset warm-up ────────────────
def _refresh_live_once():
    from src.data import live
    if not live.due(LIVE["interval_h"]):
        LIVE["stage"] = "fresh"
        return
    LIVE["stage"] = "waiting for lock"
    with plan_lock():
        LIVE["stage"] = "fetching + building"
        t0 = time.time()
        try:
            q = live.refresh()
            LIVE.update({"last_ok_utc": q["fetched_utc"], "objects": q["unique_objects"],
                         "source": q["source_kind"], "took_s": round(time.time() - t0, 1)})
            LIVE.pop("error", None)
        except Exception as e:  # network down, rate limited, bad data: keep serving the previous catalog
            LIVE["error"] = f"{type(e).__name__}: {e}"
            LIVE["last_error_utc"] = datetime.now(timezone.utc).isoformat()
            app.logger.exception("live refresh failed")
        finally:
            P = planner()
            P.release_memory()
            _CATALOG_CACHE.clear()
    LIVE["stage"] = "idle"


def _warm_presets():
    WARM["stage"] = "importing planner"
    t0 = time.time()
    try:
        P = planner()
        WARM["import_s"] = round(time.time() - t0, 1)
    except Exception as e:
        WARM["error"] = f"{type(e).__name__}: {e}"
        app.logger.exception("planner import failed")
        return
    for i, p in enumerate(resolved_presets(active_quality()["reference_epoch"]), 1):
        try:
            WARM["stage"] = f"waiting for lock (preset {i})"
            with plan_lock():
                WARM["stage"] = f"computing preset {i}: {p['label']}"
                t1 = time.time()
                P.run_preset(p)
                WARM.setdefault("preset_s", []).append(round(time.time() - t1, 1))
                P.release_memory()
        except Exception as e:  # warming is best-effort; a failure only means a slower first click
            WARM["error"] = f"{type(e).__name__}: {e}"
            app.logger.exception("preset warm-up failed for %s", p["label"])
        WARM["done"] += 1
    WARM["stage"] = "done"


def _background():
    """Exactly one worker owns the background duties (non-blocking file lock held forever)."""
    owner = _own(".background.lock")
    if owner is None:
        WARM["owner"] = LIVE["owner"] = "another worker"
        return
    if LIVE["enabled"]:
        _refresh_live_once()
    if os.getenv("SDATOS_WARM", "1") == "1":
        _warm_presets()
    while LIVE["enabled"]:
        time.sleep(900)
        _refresh_live_once()


_BG_STARTED_PID = None


@app.before_request
def _start_background_once_per_worker():
    """Start background work lazily, inside the worker. Never at import time: with gunicorn --preload
    the module is imported in the master and then forked, and threads do not survive a fork (the
    workers would inherit a frozen status, a half-imported planner and possibly a held lock)."""
    global _BG_STARTED_PID
    if _BG_STARTED_PID != os.getpid() and (LIVE["enabled"] or os.getenv("SDATOS_WARM", "1") == "1"):
        _BG_STARTED_PID = os.getpid()
        WARM.update({"done": 0, "stage": "starting"})
        WARM.pop("error", None)
        threading.Thread(target=_background, daemon=True).start()


def _reset_after_fork():
    """A lock copied mid-acquire into a forked child would stay locked forever."""
    global _IMPORT_LOCK, _THREAD_LOCK
    _IMPORT_LOCK, _THREAD_LOCK = threading.Lock(), threading.Lock()


os.register_at_fork(after_in_child=_reset_after_fork)


def catalog_window():
    """Valid launch window around the active catalog's newest element set (no catalog load)."""
    ref = datetime.fromisoformat(active_quality()["reference_epoch"])
    return ref - timedelta(days=3), ref + timedelta(days=2)


def _artifact(name):
    p = S.ARTIFACTS_DIR / name
    return json.loads(p.read_text()) if p.exists() else None


# ── Pages ───────────────────────────────────────────────────────────────────
@app.get("/")
def game():
    return render_template("sentinel.html")


@app.get("/planner")
def console():
    return render_template("console.html")


@app.get("/evidence")
def evidence():
    return render_template("evidence.html", quality=active_quality(),
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


@app.get("/healthz")
def healthz():
    q = active_quality()
    return jsonify({"ok": True, "presets_warm": WARM, "live": LIVE, "pid": os.getpid(),
                    "dataset": {"kind": q["dataset"], "reference_epoch": q["reference_epoch"],
                                "objects": q["unique_objects"]},
                    "uptime_s": round(time.time() - STARTED), "python": platform.python_version()})


# ── API ─────────────────────────────────────────────────────────────────────
@app.get("/api/meta")
def meta():
    lo, hi = catalog_window()
    q = active_quality()
    rockets = [{"name": r.name, "site": r.launch_site, "lat": r.lat_deg, "lon": r.lon_deg,
                "orbit": r.orbit_type, "max_alt_km": r.max_alt_km}
               for r in load_rockets() if r.orbit_type != "Interplanetary"]
    ev = _artifact("evaluation.json") or {}
    return jsonify({"rockets": rockets, "presets": resolved_presets(q["reference_epoch"]),
                    "window": {"min": lo.strftime("%Y-%m-%dT%H:%M"), "max": hi.strftime("%Y-%m-%dT%H:%M")},
                    "quality": q, "model": ev.get("policies") or {}})


CATALOG_FIELDS = ["norad_id", "name", "object_type", "owner", "hbr_km", "perigee_km", "apogee_km",
                  "inclination_deg", "epoch", "line1", "line2"]
_CATALOG_CACHE: dict = {}


def _catalog_blob():
    """Active catalog as gzipped JSON, built once per catalog version (csv module: no pandas)."""
    ds = active_dataset()
    stamp = f"{ds['catalog']}:{ds['catalog'].stat().st_mtime_ns}"
    if _CATALOG_CACHE.get("stamp") != stamp:
        rows = []
        with open(ds["catalog"], newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                rows.append([int(r["norad_id"]), r["name"], r["object_type"], r.get("owner", ""),
                             round(float(r["hbr_km"]), 4), round(float(r["perigee_km"]), 1),
                             round(float(r["apogee_km"]), 1), round(float(r["inclination_deg"]), 3),
                             r["epoch"][:19].replace(" ", "T"), r["line1"], r["line2"]])
        q = active_quality()
        body = json.dumps({"meta": {"dataset": q["dataset"], "reference_epoch": q["reference_epoch"],
                                    "sources": q.get("sources", []), "objects": len(rows),
                                    "partial_catalog": q.get("partial_catalog", False),
                                    "object_types": q.get("object_types", {})},
                           "fields": CATALOG_FIELDS, "rows": rows}, separators=(",", ":")).encode()
        _CATALOG_CACHE.clear()
        _CATALOG_CACHE.update(stamp=stamp, gz=gzip.compress(body, 6),
                              etag=hashlib.sha1(stamp.encode()).hexdigest()[:16],
                              lines={r[0]: (r[9], r[10]) for r in rows})
    return _CATALOG_CACHE


@app.get("/api/catalog")
def catalog():
    c = _catalog_blob()
    if request.headers.get("If-None-Match") == c["etag"]:
        return Response(status=304)
    resp = Response(c["gz"], mimetype="application/json")
    resp.headers.update({"Content-Encoding": "gzip", "ETag": c["etag"], "Cache-Control": "no-cache",
                         "Vary": "Accept-Encoding"})
    resp.direct_passthrough = True     # already compressed: keep flask-compress off it
    return resp


@app.get("/api/sgp4-check")
def sgp4_check():
    """Reference SGP4 (python-sgp4, the C++ Vallado implementation) for up to 20 objects at one time.
    The game propagates in the browser with satellite.js and compares against this."""
    from sgp4.api import Satrec, jday
    try:
        ids = [int(x) for x in request.args.get("ids", "").split(",") if x][:20]
        t = datetime.fromisoformat(request.args["t"].replace("Z", "+00:00"))
    except (KeyError, ValueError):
        return jsonify({"error": "usage: ?ids=25544,48274&t=2025-03-12T06:00:00Z"}), 400
    lines = _catalog_blob()["lines"]
    jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond * 1e-6)
    out = {}
    for i in ids:
        if i in lines:
            e, r, v = Satrec.twoline2rv(*lines[i]).sgp4(jd, fr)
            out[i] = {"error": e, "r_km": r, "v_kms": v}
    return jsonify({"t": t.isoformat(), "positions": out})


@app.post("/api/plan")
def api_plan():
    d = request.get_json(force=True, silent=True)
    if not isinstance(d, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400
    try:
        launch = datetime.fromisoformat(d["launch_time"]).replace(tzinfo=timezone.utc)
        alt = float(d["target_alt_km"])
        if not 300 <= alt <= 2000:
            raise ValueError("Target altitude must be 300-2000 km (LEO)")
        inc = d.get("inclination_deg")
        inc = float(inc) if inc not in (None, "") else None
        threats = max(0, min(int(d.get("synthetic_threats", 0)), 6))
        slip = max(0.0, min(float(d.get("slip_allowed_s", 600)), 600.0))
        seed = int(d.get("seed", 0))
        if not 0 <= seed <= MAX_SEED:     # every distinct seed is a new disk-cache entry
            raise ValueError(f"Seed must be 0-{MAX_SEED}")
        lo, hi = catalog_window()
        if not lo <= launch <= hi:
            raise ValueError(f"Launch time must be inside the TLE validity window {lo:%Y-%m-%d %H:%M} .. {hi:%Y-%m-%d %H:%M} UTC")
        P = planner()
        with plan_lock():
            rep = P.plan_mission_cached(d["rocket"], alt, launch, inc, threats, slip, seed)
            P.release_memory()
    except KeyError as e:
        return jsonify({"error": f"Missing or unknown field: {e}"}), 400
    except (TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("plan failed")
        return jsonify({"error": f"Internal error ({type(e).__name__}): {e}"}), 500
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
