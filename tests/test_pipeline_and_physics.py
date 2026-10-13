from collections import Counter
from datetime import datetime, timezone

import numpy as np
import pytest

from src.config import settings as S
from src.data.tle_pipeline import parse_pair, parse_tle_text, tle_checksum, _alpha5_to_int, _parse_exp
from src.physics.mission import (MissionSpec, ManeuverPlan, get_rocket, trajectory, orbit_inclination_deg,
                                 circular_velocity)

ISS_1 = "1 25544U 98067A   25069.51782528  .00016717  00000-0  29691-3 0  9990"
ISS_2 = "2 25544  51.6371 154.5512 0006199 315.8812  44.1735 15.49814694499542"
T0 = datetime(2025, 3, 12, 6, 0, tzinfo=timezone.utc)


def _fix_checksum(line):
    return line[:68] + str(tle_checksum(line))


def test_checksum_and_parse():
    l1, l2 = _fix_checksum(ISS_1), _fix_checksum(ISS_2)
    rec = parse_pair(l1, l2, "ISS (ZARYA)")
    assert rec.norad_id == 25544 and rec.name == "ISS (ZARYA)"
    assert rec.epoch.year == 2025 and rec.epoch.timetuple().tm_yday == 69
    assert abs(rec.inclination_deg - 51.6371) < 1e-9
    assert abs(rec.bstar - 0.29691e-3) < 1e-12


def test_rejects_corrupted_checksum():
    l1, l2 = _fix_checksum(ISS_1), _fix_checksum(ISS_2)
    bad = l1[:68] + str((int(l1[68]) + 1) % 10)
    with pytest.raises(ValueError, match="bad_checksum"):
        parse_pair(bad, l2)


def test_parse_3le_and_stats():
    l1, l2 = _fix_checksum(ISS_1), _fix_checksum(ISS_2)
    stats = Counter()
    recs = parse_tle_text(["0 ISS (ZARYA)\n", l1, l2, "1 broken line\n"], stats)
    assert len(recs) == 1 and recs[0].name == "ISS (ZARYA)"
    assert stats["parsed_ok"] == 1 and stats["rejected_orphan_line"] == 1


def test_alpha5_and_exponent_fields():
    assert _alpha5_to_int("A0001") == 100001
    assert _alpha5_to_int("25544") == 25544
    assert _parse_exp(" 13742-2") == pytest.approx(0.13742e-2)
    assert _parse_exp("-11606-4") == pytest.approx(-0.11606e-4)


@pytest.fixture
def spec():
    return MissionSpec(get_rocket("Electron"), 500, T0)


def test_inclination_and_insertion_speed(spec):
    assert orbit_inclination_deg(spec) == pytest.approx(spec.inclination_deg, abs=1e-6)
    pos, vel = trajectory(spec, ManeuverPlan(), np.array([spec.ascent_s + 100, spec.ascent_s + 110, spec.ascent_s + 120]))
    r = np.linalg.norm(pos[1])
    assert r - S.RE_KM == pytest.approx(500, abs=1e-6)
    assert np.linalg.norm(vel[1]) == pytest.approx(circular_velocity(r), rel=1e-3)


def test_sso_launch_is_retrograde():
    s = MissionSpec(get_rocket("PSLV"), 700, T0, inclination_deg=97.5)
    assert orbit_inclination_deg(s) == pytest.approx(97.5, abs=1e-6)
    assert s.launch_azimuth_deg() < 0


def test_unreachable_inclination_rejected():
    with pytest.raises(ValueError):
        MissionSpec(get_rocket("Electron"), 500, T0, inclination_deg=20.0)  # site latitude 39.3


def test_launch_slip_rotates_plane_by_earth_rate(spec):
    def node(plan):
        p, v = trajectory(spec, plan, np.array([spec.ascent_s + 60, spec.ascent_s + 70]))
        h = np.cross(p[0], v[0])
        return np.arctan2(h[0], -h[1])  # RAAN
    d = node(ManeuverPlan(slip_s=600)) - node(ManeuverPlan())
    assert d == pytest.approx(S.OMEGA_EARTH * 600, rel=1e-3)


def test_prograde_burn_raises_orbit(spec):
    tau = np.array([spec.ascent_s + spec.period_s / 2])
    lo, _ = trajectory(spec, ManeuverPlan(), tau)
    hi, _ = trajectory(spec, ManeuverPlan(dv_ms=2.0), tau)
    # half an orbit after a prograde impulse we are at apogee: higher by ~4a^2 dv / mu * v
    assert np.linalg.norm(hi) - np.linalg.norm(lo) > 3.0
