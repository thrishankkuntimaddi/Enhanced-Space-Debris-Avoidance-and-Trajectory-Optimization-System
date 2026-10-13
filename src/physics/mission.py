# src/physics/mission.py
"""
Launch-to-orbit trajectory model for the vehicle being planned.

  * Launch site (geodetic) is rotated into TEME at the actual launch instant (GMST), so the
    launch slip changes the orbital plane's RAAN exactly as Earth rotation does in reality.
  * Launch azimuth from spherical trig:  sin(beta) = cos(i) / cos(lat).
  * Ascent: a kinematic in-plane profile (altitude eases into the target, downrange angle is
    chosen so horizontal speed at insertion equals circular velocity -> no discontinuity).
  * Orbit: two-body Keplerian motion from the insertion state. An along-track impulse dv at
    insertion makes the orbit slightly elliptical (phasing), solved with Newton on Kepler's eq.

The decision variables the optimizer controls are bundled in ManeuverPlan.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict, field
from datetime import datetime, timedelta

import csv

import numpy as np

from src.config import settings as S
from src.physics.frames import gmst, geodetic_to_ecef, ecef_to_teme


@dataclass
class Rocket:
    name: str
    launch_site: str
    lat_deg: float
    lon_deg: float
    orbit_type: str
    max_alt_km: float
    thrust_n: float
    mass_kg: float
    burn_time_s: float
    fuel_capacity_kg: float


def load_rockets() -> list[Rocket]:
    with open(S.ROCKET_CSV, newline="", encoding="utf-8") as f:
        return [Rocket(r["Rocket_Type"], r["Launch_Site"], float(r["x0"]), float(r["y0"]), r["Type_of_Orbit"],
                       float(r["Max_Altitude_km"]), float(r["Thrust_N"]), float(r["Mass_kg"]),
                       float(r["Burn_Time_s"]), float(r["Total_Fuel_Capacity_kg"])) for r in csv.DictReader(f)]


def get_rocket(name: str) -> Rocket:
    for r in load_rockets():
        if r.name == name:
            return r
    raise KeyError(f"Unknown rocket {name!r}")


@dataclass
class ManeuverPlan:
    slip_s: float = 0.0      # launch time slip relative to nominal
    dalt_km: float = 0.0     # insertion altitude offset
    dv_ms: float = 0.0       # along-track phasing impulse at insertion

    def as_dict(self):
        return asdict(self)


@dataclass
class MissionSpec:
    rocket: Rocket
    target_alt_km: float
    launch_time: datetime            # nominal, UTC
    inclination_deg: float | None = None
    horizon_orbits: float = 1.5      # how long after insertion we screen
    dt_s: float = S.SCREEN_DT_S
    _cache: dict = field(default_factory=dict, repr=False, compare=False)

    def __post_init__(self):
        lat = abs(self.rocket.lat_deg)
        if self.inclination_deg is None:
            self.inclination_deg = float(np.ceil(lat * 10) / 10)
        if self.inclination_deg < lat - 1e-6 and self.inclination_deg < 180 - lat:
            raise ValueError(f"Inclination {self.inclination_deg} deg not reachable from latitude {lat:.1f}")

    @property
    def ascent_s(self) -> float:
        return 420.0 + 0.6 * self.rocket.burn_time_s + 0.1 * self.target_alt_km

    @property
    def period_s(self) -> float:
        a = S.RE_KM + self.target_alt_km
        return 2 * np.pi * np.sqrt(a ** 3 / S.MU_KM3_S2)

    @property
    def duration_s(self) -> float:
        return self.ascent_s + self.horizon_orbits * self.period_s

    @property
    def tau(self) -> np.ndarray:
        """Mission-relative sample times (s since actual launch)."""
        return np.arange(0.0, self.duration_s + self.dt_s, self.dt_s)

    def launch_azimuth_deg(self) -> float:
        # geocentric latitude: the orbit plane passes through Earth's centre, not the ellipsoid normal
        r = geodetic_to_ecef(self.rocket.lat_deg, self.rocket.lon_deg)
        lat_gc = np.arcsin(r[2] / np.linalg.norm(r))
        return float(np.degrees(np.arcsin(np.clip(np.cos(np.radians(self.inclination_deg)) / np.cos(lat_gc), -1, 1))))


def circular_velocity(r_km):
    return np.sqrt(S.MU_KM3_S2 / r_km)


def maneuver_dv_cost_ms(spec: MissionSpec, plan: ManeuverPlan) -> float:
    """Extra delta-v vs. the nominal plan (m/s): Hohmann-like altitude change + phasing burn."""
    r = S.RE_KM + spec.target_alt_km
    alt_cost = circular_velocity(r) * abs(plan.dalt_km) / (2 * r) * 1000.0
    return float(alt_cost + abs(plan.dv_ms))


def _solve_kepler(M, e, iters=8):
    E = M + e * np.sin(M)
    for _ in range(iters):
        E = E - (E - e * np.sin(E) - M) / (1 - e * np.cos(E))
    return E


def trajectory(spec: MissionSpec, plan: ManeuverPlan, tau: np.ndarray | None = None):
    """Return (positions, velocities) in TEME km, km/s at mission-relative times tau."""
    tau = spec.tau if tau is None else np.asarray(tau, dtype=float)
    launch = spec.launch_time + timedelta(seconds=float(plan.slip_s))
    theta = float(gmst(launch))
    r_site = ecef_to_teme(geodetic_to_ecef(spec.rocket.lat_deg, spec.rocket.lon_deg), theta)
    R0 = np.linalg.norm(r_site)
    u_hat = r_site / R0
    e_hat = np.cross([0.0, 0.0, 1.0], u_hat)
    e_hat /= np.linalg.norm(e_hat)
    n_hat = np.cross(u_hat, e_hat)
    beta = np.radians(spec.launch_azimuth_deg())
    d_hat = np.cos(beta) * n_hat + np.sin(beta) * e_hat

    r_ins = S.RE_KM + spec.target_alt_km + plan.dalt_km
    t_asc = spec.ascent_s
    n_c = np.sqrt(S.MU_KM3_S2 / r_ins ** 3)
    theta_asc = n_c * t_asc / 2.0

    radius = np.empty_like(tau)
    u = np.empty_like(tau)
    asc = tau <= t_asc
    s = tau[asc] / t_asc
    radius[asc] = R0 + (r_ins - R0) * (3 * s ** 2 - 2 * s ** 3)  # smoothstep: zero climb rate at pad & insertion
    u[asc] = theta_asc * s ** 2

    # Keplerian coast from insertion (insertion point is an apsis: velocity purely tangential)
    v0 = circular_velocity(r_ins) + plan.dv_ms / 1000.0
    a = 1.0 / (2.0 / r_ins - v0 ** 2 / S.MU_KM3_S2)
    e = abs(r_ins * v0 ** 2 / S.MU_KM3_S2 - 1.0)
    nu0 = 0.0 if v0 >= circular_velocity(r_ins) else np.pi
    M0 = 0.0 if nu0 == 0.0 else np.pi
    tc = tau[~asc] - t_asc
    E = _solve_kepler(M0 + np.sqrt(S.MU_KM3_S2 / a ** 3) * tc, e)
    nu = 2 * np.arctan2(np.sqrt(1 + e) * np.sin(E / 2), np.sqrt(1 - e) * np.cos(E / 2))
    radius[~asc] = a * (1 - e * np.cos(E))
    u[~asc] = theta_asc + (nu - nu0)

    pos = radius[:, None] * (np.cos(u)[:, None] * u_hat + np.sin(u)[:, None] * d_hat)
    vel = np.gradient(pos, tau, axis=0) if len(tau) > 1 else np.zeros_like(pos)
    return pos, vel


def orbit_inclination_deg(spec: MissionSpec, plan: ManeuverPlan | None = None) -> float:
    pos, vel = trajectory(spec, plan or ManeuverPlan(), np.array([spec.ascent_s + 60, spec.ascent_s + 70]))
    h = np.cross(pos[0], vel[0])
    return float(np.degrees(np.arccos(h[2] / np.linalg.norm(h))))
