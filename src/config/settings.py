# src/config/settings.py
"""
Centralized path and configuration settings for the SDATOS project.
All module-level paths should be imported from here.
"""
from pathlib import Path

# Resolve project root (2 levels up from this file: src/config/settings.py → project root)
PROJECT_ROOT = Path(__file__).resolve().parents[2]

# ── Data paths ─────────────────────────────────────────────────────────────
DATA_DIR        = PROJECT_ROOT / "data"
INPUTS_DIR      = PROJECT_ROOT / "inputs"
OUTPUTS_DIR     = PROJECT_ROOT / "outputs"
MODELS_DIR      = PROJECT_ROOT / "models"
REPORTS_DIR     = OUTPUTS_DIR / "mission_reports"
STATIC_DIR      = PROJECT_ROOT / "src" / "interface" / "static"

# Specific files
ROCKET_CSV      = DATA_DIR / "rocket_parameters.csv"
TLE_RAW         = INPUTS_DIR / "tle_raw.txt"
TLE_DATA        = DATA_DIR / "tle_data.txt"
DDQL_WEIGHTS    = MODELS_DIR / "ddql_optimizer_weights.npz"

# ── Ensure runtime directories exist ───────────────────────────────────────
for _dir in (DATA_DIR, INPUTS_DIR, OUTPUTS_DIR, MODELS_DIR, REPORTS_DIR, STATIC_DIR):
    _dir.mkdir(parents=True, exist_ok=True)
