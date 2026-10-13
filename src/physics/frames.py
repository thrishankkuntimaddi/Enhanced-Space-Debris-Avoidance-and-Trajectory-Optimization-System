# src/physics/frames.py
"""Time and reference-frame helpers. Everything is expressed in TEME, the frame SGP4 outputs,
so the vehicle and the debris are compared in the same inertial frame."""
from __future__ import annotations

from datetime import datetime

import numpy as np
from sgp4.api import jday
from sgp4.propagation import gstime

from src.config import settings as S


def to_jd(dt: datetime) -> tuple[float, float]:
    return jday(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second + dt.microsecond * 1e-6)


def gmst(dt: datetime, offset_s: float | np.ndarray = 0.0):
    jd, fr = to_jd(dt)
    return np.vectorize(gstime)(jd + fr + np.asarray(offset_s) / 86400.0)


def geodetic_to_ecef(lat_deg: float, lon_deg: float, alt_km: float = 0.0) -> np.ndarray:
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    e2 = S.WGS84_F * (2 - S.WGS84_F)
    n = S.WGS84_A / np.sqrt(1 - e2 * np.sin(lat) ** 2)
    return np.array([(n + alt_km) * np.cos(lat) * np.cos(lon),
                     (n + alt_km) * np.cos(lat) * np.sin(lon),
                     (n * (1 - e2) + alt_km) * np.sin(lat)])


def ecef_to_teme(r_ecef: np.ndarray, theta: float) -> np.ndarray:
    """Rotate an Earth-fixed vector into TEME by Greenwich sidereal angle theta (polar motion ignored)."""
    c, s = np.cos(theta), np.sin(theta)
    return np.array([c * r_ecef[0] - s * r_ecef[1], s * r_ecef[0] + c * r_ecef[1], r_ecef[2]])


def rtn_basis(r: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Rows = radial, transverse (along-track), normal unit vectors. Works on (...,3)."""
    rh = r / np.linalg.norm(r, axis=-1, keepdims=True)
    h = np.cross(r, v)
    nh = h / np.linalg.norm(h, axis=-1, keepdims=True)
    th = np.cross(nh, rh)
    return np.stack([rh, th, nh], axis=-2)
