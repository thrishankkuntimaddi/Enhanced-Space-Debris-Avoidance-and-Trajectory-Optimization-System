# src/cli.py
"""
Command line entry point.

    python -m src.cli fetch [--history]     pull a snapshot from Space-Track (or CelesTrak)
    python -m src.cli build                 7-day window -> super dataset + data-quality report
    python -m src.cli validate              SGP4 back-test -> uncertainty model
    python -m src.cli plan --rocket "Falcon 9" --alt 550 --launch 2025-03-12T06:00 [--threats 3]
    python -m src.cli figures               regenerate evidence figures
    python -m src.cli presets               recompute the committed demo-preset cache (data/preset_cache/)
    python -m src.cli all                   build + validate + figures
Training / evaluation:  python -m src.rl.train ... ;  python -m src.rl.evaluate ...
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone


def cmd_fetch(a):
    from src.data.spacetrack_client import collect
    print(f"saved snapshot: {collect(history=a.history)}")


def cmd_build(a):
    from src.data.tle_pipeline import run_pipeline, default_sources
    res = run_pipeline(default_sources())
    print(json.dumps(res.quality, indent=2, default=str))
    return res


def cmd_validate(a, res=None):
    from src.data.tle_pipeline import run_pipeline, default_sources
    from src.data.propagation_validation import run_validation
    res = res or run_pipeline(default_sources(), save=False)
    out = run_validation(res.history, res.catalog)
    print(json.dumps({"pairs": out["pairs"], "LEO": out["by_regime"]["LEO"], "sigma_model": out["sigma_model"]}, indent=2))


def cmd_figures(a):
    from src.reporting.figures import prediction_error_figure, training_figure
    prediction_error_figure()
    training_figure()
    print("figures written to artifacts/")


def cmd_presets(a):
    from src.pipeline.planner import export_preset_cache
    for label, name, size in export_preset_cache():
        print(f"{size / 1e6:5.2f} MB  {name}  {label}")


def cmd_plan(a):
    from src.pipeline.planner import plan_mission
    launch = datetime.fromisoformat(a.launch).replace(tzinfo=timezone.utc)
    r = plan_mission(a.rocket, a.alt, launch, a.inc, a.threats, a.slip, a.seed)
    r.pop("viz")
    print(f"\n{r['verdict']}   (report id {r['id']})")
    print(f"nominal : RED {r['nominal']['red']}  AMBER {r['nominal']['amber']}  min miss {r['nominal']['min_miss_km']} km")
    for c in r["nominal"]["conjunctions"][:5]:
        print(f"   {c['risk']:5s} {c['name']:28s} miss {c['miss_km']:7.3f} km  Pc {c['pc']:.1e}  TCA {c['tca_utc']}")
    d = r["decision"]
    print(f"decision: {d['policy']} | {' -> '.join(t['action'] for t in d['trace']) or 'no action'}")
    print(f"plan    : slip {d['plan']['slip_s']} s, dalt {d['plan']['dalt_km']} km, dv {d['plan']['dv_ms']} m/s "
          f"(cost {d['plan']['dv_cost_ms']} m/s), {d['screen_calls']} screenings")
    print(f"final   : RED {r['final']['red']}  AMBER {r['final']['amber']}  min miss {r['final']['min_miss_km']} km")
    print(f"timings : {r['timings']}")


def main():
    ap = argparse.ArgumentParser(prog="sdatos")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch"); f.add_argument("--history", action="store_true"); f.set_defaults(fn=cmd_fetch)
    sub.add_parser("build").set_defaults(fn=cmd_build)
    sub.add_parser("validate").set_defaults(fn=cmd_validate)
    sub.add_parser("figures").set_defaults(fn=cmd_figures)
    sub.add_parser("presets").set_defaults(fn=cmd_presets)
    p = sub.add_parser("plan")
    p.add_argument("--rocket", required=True); p.add_argument("--alt", type=float, required=True)
    p.add_argument("--launch", required=True); p.add_argument("--inc", type=float)
    p.add_argument("--threats", type=int, default=0); p.add_argument("--slip", type=float, default=600)
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(fn=cmd_plan)
    al = sub.add_parser("all")
    al.set_defaults(fn=lambda a: (cmd_validate(a, cmd_build(a)), cmd_figures(a)))
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
