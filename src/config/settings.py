# src/config/settings.py
"""
Centralized paths and physical/operational constants for SDATOS.

Units convention across the codebase: kilometres, seconds, km/s (SGP4-native).
"""
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]

# ── Directories ─────────────────────────────────────────────────────────────
DATA_DIR       = PROJECT_ROOT / "data"
INPUTS_DIR     = PROJECT_ROOT / "inputs"
SNAPSHOTS_DIR  = INPUTS_DIR / "snapshots"      # daily Space-Track / CelesTrak pulls
OUTPUTS_DIR    = PROJECT_ROOT / "outputs"
REPORTS_DIR    = OUTPUTS_DIR / "mission_reports"
MODELS_DIR     = PROJECT_ROOT / "models"
ARTIFACTS_DIR  = PROJECT_ROOT / "artifacts"    # committed evidence: metrics, figures
STATIC_DIR     = PROJECT_ROOT / "src" / "interface" / "static"

# ── Files ───────────────────────────────────────────────────────────────────
ROCKET_CSV      = DATA_DIR / "rocket_parameters.csv"
TLE_RAW         = INPUTS_DIR / "tle_raw.txt"       # seed snapshot (Space-Track, Mar 2025)
CATALOG_CSV     = DATA_DIR / "catalog.csv"         # "super dataset": 1 row per object
CATALOG_TLE     = DATA_DIR / "tle_data.txt"        # latest elset per object (3LE)
HISTORY_CSV     = DATA_DIR / "tle_history.csv"     # every valid elset in the window
LIVE_DIR        = DATA_DIR / "live"                # auto-refreshed catalog (gitignored)
POLICY_WEIGHTS  = MODELS_DIR / "ddqn_policy.npz"   # numpy weights used for serving
TORCH_CKPT      = MODELS_DIR / "ddqn_policy.pt"    # PyTorch checkpoint used for training

# ── Live data ───────────────────────────────────────────────────────────────
LIVE_MAX_AGE_DAYS    = 4.0      # a live catalog older than this is ignored (falls back to the seed)

# ── Physical constants (WGS-72, consistent with SGP4) ───────────────────────
MU_KM3_S2   = 398600.8          # km^3/s^2
RE_KM       = 6378.135          # km
OMEGA_EARTH = 7.292115146706979e-5  # rad/s
WGS84_A     = 6378.137
WGS84_F     = 1 / 298.257223563

# ── Data pipeline ───────────────────────────────────────────────────────────
WINDOW_DAYS          = 7        # TLE accuracy degrades quickly; we keep a 7-day window
STALE_AGE_DAYS       = 3.0      # elsets older than this are flagged stale
MANEUVER_DA_KM       = 1.0      # |Δa| between consecutive elsets that flags a maneuver

# ── Screening / risk ────────────────────────────────────────────────────────
SCREEN_DT_S          = 10.0     # ephemeris step; TCA refined analytically between samples
HARD_BODY_RADIUS_KM  = 0.020    # combined hard-body radius (20 m)
MISSION_SIGMA_KM     = 0.25     # 1-σ position uncertainty of our own vehicle
PC_RED               = 1e-4     # NASA CARA-style maneuver threshold
PC_AMBER             = 1e-6
MISS_RED_KM          = 1.0
MISS_AMBER_KM        = 5.0
REPORT_KM            = 25.0     # conjunctions closer than this are reported

# ── Avoidance-plan limits (shared by the screener's prune margin and the RL action space) ──
DALT_MAX_KM          = 10.0     # insertion altitude offset
DV_MAX_MS            = 3.0      # along-track phasing impulse
DV_BUDGET_MS         = 10.0     # total extra delta-v

for _d in (DATA_DIR, INPUTS_DIR, SNAPSHOTS_DIR, OUTPUTS_DIR, REPORTS_DIR, MODELS_DIR, ARTIFACTS_DIR):
    _d.mkdir(parents=True, exist_ok=True)
