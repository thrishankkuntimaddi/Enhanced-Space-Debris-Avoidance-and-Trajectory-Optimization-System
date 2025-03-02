import numpy as np
import pandas as pd
from sgp4.api import Satrec
from sgp4.api import jday
import os


class CollisionDetector:
    def __init__(self, tle_data_path="/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/tle_data.csv",
                 threshold_km=1.0):
        if not os.path.exists(tle_data_path):
            raise FileNotFoundError(f"TLE data file not found at {tle_data_path}")
        dtypes = {'Satellite_Num': str, 'Satellite_Num_2': str}
        self.tle_df = pd.read_csv(tle_data_path, dtype=dtypes)
        self.threshold = threshold_km

    def _parse_tle_float(self, value, is_eccentricity=False):
        """Convert TLE value (string or float) to float, special handling for eccentricity."""
        if isinstance(value, float):
            return value
        try:
            value_str = str(value).strip()
            if value_str == '00000-0' or value_str == '0':
                return 0.0
            if '-' in value_str or '+' in value_str:  # e.g., '46878-3'
                coeff = float(value_str[:5]) / 100000
                exp = int(value_str[6:])
                if exp > 300:
                    print(f"Warning: Exponent {exp} too large in '{value_str}', using 0")
                    return 0.0
                return coeff * (10 ** exp)
            if is_eccentricity and len(value_str) == 7 and value_str.isdigit():  # e.g., '31782'
                return float(f"0.{value_str}")
            return float(value_str)  # e.g., '.00004572'
        except (ValueError, IndexError) as e:
            print(f"Error parsing TLE float '{value}': {e}")
            return 0.0

    def get_debris_positions(self, timestamp, t):
        jd, fr = jday(timestamp.year, timestamp.month, timestamp.day,
                      timestamp.hour, timestamp.minute, timestamp.second + t)
        positions = []

        for _, row in self.tle_df.iterrows():
            sat = Satrec()
            sat.sgp4init(
                1,  # whichconst (WGS72)
                'i',  # opsmode
                int(row['Satellite_Num']),
                float(row['Epoch_Year_Day']) - 2440000.5,
                self._parse_tle_float(row['BSTAR']),
                self._parse_tle_float(row['First_Derivative']),
                self._parse_tle_float(row['Second_Derivative']),
                self._parse_tle_float(row['Eccentricity'], is_eccentricity=True),
                np.radians(float(row['Arg_of_Perigee_deg'])),
                np.radians(float(row['Inclination_deg'])),
                np.radians(float(row['Mean_Anomaly_deg'])),
                float(row['Mean_Motion']) * 2 * np.pi / (24 * 60),
                np.radians(float(row['RAAN_deg']))
            )
            e, r, v = sat.sgp4(jd, fr)
            if e == 0:
                positions.append(np.array(r))
            else:
                print(f"SGP4 error for satellite {row['Satellite_Num']}: {e}")
                print(
                    f"  Eccentricity: {row['Eccentricity']}, Parsed: {self._parse_tle_float(row['Eccentricity'], is_eccentricity=True)}")
                print(f"  Mean Motion: {row['Mean_Motion']}")
        return positions

    def detect_collision(self, rocket_pos, debris_positions):
        for debris_pos in debris_positions:
            distance = np.linalg.norm(rocket_pos - debris_pos)
            if distance < self.threshold:
                print(f"Collision detected! Distance: {distance:.2f} km")
                return True
        return False

    def check_trajectory(self, equations, t_max, timestamp, num_points=50):
        t_values = np.linspace(0, t_max, num_points)
        collisions = []

        x_func = lambda t: eval(equations['x'], {'t': t, 'np': np})
        y_func = lambda t: eval(equations['y'], {'t': t, 'np': np})
        burn_time = float(equations['z'].split('<=')[1].split()[0])
        z_func = lambda t: eval(equations['z'].split('if')[0], {'t': t, 'np': np}) if t <= burn_time else eval(
            equations['z'].split('else')[1], {'t': t, 'np': np})

        for t in t_values:
            rocket_pos = np.array([x_func(t), y_func(t), z_func(t) / 1000])
            debris_positions = self.get_debris_positions(timestamp, t)
            if self.detect_collision(rocket_pos, debris_positions):
                collisions.append((t, rocket_pos))

        return collisions


if __name__ == "__main__":
    from datetime import datetime

    test_equations = {
        'x': '-39.261 + 5649.37 * t',
        'y': '177.864 + 5258.77 * t',
        'z': '0 + 2074.13 * t**2 if t <= 80 else 13279360.0'
    }
    t_max = 15.54
    timestamp = datetime(2025, 3, 1, 12, 0, 0)

    detector = CollisionDetector()
    collisions = detector.check_trajectory(test_equations, t_max, timestamp)
    if collisions:
        print(f"Collisions detected at: {collisions}")
    else:
        print("No collisions detected along trajectory")