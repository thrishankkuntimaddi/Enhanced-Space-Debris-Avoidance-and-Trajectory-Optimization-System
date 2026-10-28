"""Demo presets: shown in the classic planner and pre-computed at startup so they answer instantly.

Launch times are relative to the active catalog's reference day (the UTC day of its newest
element set), so the presets stay inside the valid window whether the app is serving the
committed seed snapshot or an auto-refreshed live catalog. For the seed snapshot (reference
2025-03-13) they resolve to the dates used throughout the README.
"""
from datetime import datetime, timedelta

PRESETS = [
    {"label": "Real catalog · Falcon 9 → 550 km (Starlink shell)", "rocket": "Falcon 9", "alt": 550,
     "day": -1, "time": "06:00", "threats": 0, "slip": 600, "seed": 0},
    {"label": "Real catalog · PSLV → 700 km SSO 97.5°", "rocket": "PSLV", "alt": 700, "inc": 97.5,
     "day": -2, "time": "04:30", "threats": 0, "slip": 300, "seed": 0},
    {"label": "Stress test · Electron 500 km, 3 threat events", "rocket": "Electron", "alt": 500,
     "day": -1, "time": "09:00", "threats": 3, "slip": 600, "seed": 4},
    {"label": "Stress test · instantaneous window, 4 events", "rocket": "Vega", "alt": 600,
     "day": -2, "time": "18:00", "threats": 4, "slip": 0, "seed": 7},
]


def resolve(preset: dict, reference_epoch: str) -> dict:
    """Copy of the preset with an absolute 'launch' (YYYY-MM-DDTHH:MM, UTC)."""
    ref_day = datetime.fromisoformat(reference_epoch).replace(hour=0, minute=0, second=0, microsecond=0)
    hh, mm = map(int, preset["time"].split(":"))
    launch = ref_day + timedelta(days=preset["day"], hours=hh, minutes=mm)
    return {**preset, "launch": launch.strftime("%Y-%m-%dT%H:%M")}


def resolved(reference_epoch: str) -> list[dict]:
    return [resolve(p, reference_epoch) for p in PRESETS]
