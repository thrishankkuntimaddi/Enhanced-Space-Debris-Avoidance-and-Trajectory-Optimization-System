# src/interface/app.py
"""
SDATOS web service.

  GET  /                      mission console (three.js)
  GET  /evidence              data quality, prediction back-test, training & evaluation results
  GET  /report/<id>           printable mission report
  GET  /api/meta              rockets, valid launch window, data provenance, model card
  POST /api/plan              run the full pipeline for one mission
  GET  /api/report/<id>       report JSON
  GET  /artifacts/<file>      committed evidence (figures, metrics JSON)
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from flask import Flask, abort, jsonify, render_template, request, send_from_directory

from src.config import settings as S
from src.physics.mission import load_rockets
from src.pipeline.planner import catalog_window, plan_mission

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

SAFE_ID = re.compile(r"^[A-Za-z0-9_\-]+$")


def _artifact(name):
    p = S.ARTIFACTS_DIR / name
    return json.loads(p.read_text()) if p.exists() else None


@app.get("/")
def console():
    return render_template("console.html")


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
                "orbit": r.orbit_type, "max_alt_km": r.max_alt_km} for r in load_rockets() if r.orbit_type != "Interplanetary"]
    ev = _artifact("evaluation.json") or {}
    return jsonify({"rockets": rockets,
                    "window": {"min": lo.strftime("%Y-%m-%dT%H:%M"), "max": hi.strftime("%Y-%m-%dT%H:%M")},
                    "quality": _artifact("data_quality.json"),
                    "model": {k: v for k, v in (ev.get("policies") or {}).items()}})


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
        rep = plan_mission(d["rocket"], alt, launch, inc, threats, slip, int(d.get("seed", 0)))
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
    app.run(debug=False, port=5000)
