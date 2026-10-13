# src/pipeline/presets.py
"""Demo presets: shown in the console and pre-computed at startup so they answer instantly."""

PRESETS = [
    {"label": "Real catalog · Falcon 9 → 550 km (Starlink shell)", "rocket": "Falcon 9", "alt": 550,
     "launch": "2025-03-12T06:00", "threats": 0, "slip": 600, "seed": 0},
    {"label": "Real catalog · PSLV → 700 km SSO 97.5°", "rocket": "PSLV", "alt": 700, "inc": 97.5,
     "launch": "2025-03-11T04:30", "threats": 0, "slip": 300, "seed": 0},
    {"label": "Stress test · Electron 500 km, 3 threat events", "rocket": "Electron", "alt": 500,
     "launch": "2025-03-12T09:00", "threats": 3, "slip": 600, "seed": 4},
    {"label": "Stress test · instantaneous window, 4 events", "rocket": "Vega", "alt": 600,
     "launch": "2025-03-11T18:00", "threats": 4, "slip": 0, "seed": 7},
]


