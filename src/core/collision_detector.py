# src/core/collision_detector.py
import numpy as np
from datetime import timedelta
from sgp4.api import Satrec, jday

class CollisionDetector:
    def __init__(self, tle_txt_path, threshold_km=1.0):
        self.tle_txt_path = tle_txt_path
        self.threshold_km = threshold_km

    def load_tle_data(self):
        """Load TLE data and create Satrec objects."""
        satellites = []
        with open(self.tle_txt_path, 'r') as f:
            lines = f.readlines()
            for i in range(0, len(lines), 2):
                line1 = lines[i].strip()
                line2 = lines[i + 1].strip()
                try:
                    sat = Satrec.twoline2rv(line1, line2)
                    satellites.append(sat)
                except Exception as e:
                    print(f"Skipping invalid TLE: {e}")
        return satellites

    def detect_collisions(self, trajectory_equations, launch_timestamp, t_climb):
        """Detect collisions with fewer time steps."""
        satellites = self.load_tle_data()
        collisions = []

        # Time steps: every 10 seconds (adjustable)
        step_size = 10.0
        t_steps = np.arange(0, t_climb, step_size)
        print(f"Checking {len(t_steps)} time steps against {len(satellites)} satellites...")

        jd_launch, fr_launch = jday(launch_timestamp.year, launch_timestamp.month, launch_timestamp.day,
                                   launch_timestamp.hour, launch_timestamp.minute, launch_timestamp.second)

        for t in t_steps:
            x = trajectory_equations['x'](t)
            y = trajectory_equations['y'](t)
            z = trajectory_equations['z'](t)
            rocket_pos = np.array([x, y, z])

            delta_t_days = t / 86400.0
            jd = jd_launch
            fr = fr_launch + delta_t_days
            if fr >= 1.0:
                jd += int(fr)
                fr = fr % 1.0

            for sat in satellites:
                try:
                    e, r, v = sat.sgp4(jd, fr)
                    if e != 0:
                        continue
                    debris_pos = np.array(r) * 1000  # km to meters
                    distance = np.linalg.norm(rocket_pos - debris_pos) / 1000  # to km
                    if distance < self.threshold_km:
                        collisions.append((t, tuple(debris_pos)))
                except Exception:
                    continue

        return collisions

if __name__ == "__main__":
    from datetime import datetime
    traj = {
        'x': lambda t: 5.0e6,
        'y': lambda t: 0.0,
        'z': lambda t: 6371e3 + 7800 * t
    }
    detector = CollisionDetector("/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/tle_data.txt")
    collisions = detector.detect_collisions(traj, datetime(2024, 6, 6, 5, 11, 42), 500.0)
    print(f"Collisions: {collisions}")