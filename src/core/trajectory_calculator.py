# src/core/trajectory_calculator.py
import numpy as np

class TrajectoryCalculator:
    def __init__(self):
        self.R = 6371e3  # Earth radius (m)
        self.GM = 3.986e14  # Gravitational parameter (m^3/s^2)

    def calculate(self, rocket_type, altitude_km, initial_position):
        altitude = altitude_km * 1000  # Target: 20,000 km
        lat0, lon0, z0 = initial_position  # e.g., (28.5, -80.5, 0)
        v0 = 7800  # m/s
        burn_time = 80.0  # s
        theta0 = np.radians(lat0)
        phi0 = np.radians(lon0)
        r0 = self.R + z0
        x0 = r0 * np.cos(theta0) * np.cos(phi0)
        y0 = r0 * np.cos(theta0) * np.sin(phi0)
        z0 = r0 * np.sin(theta0)

        pitch_angle = np.radians(45)
        vx = v0 * np.cos(pitch_angle)
        vz = v0 * np.sin(pitch_angle)
        t_climb = (altitude - z0) / vz  # Time to reach altitude from surface

        # Orbital velocity at target altitude
        r_target = self.R + altitude
        v_orbit = np.sqrt(self.GM / r_target)  # Circular orbit speed

        equations = {
            'x': lambda t: x0 + vx * t * np.cos(phi0) if t <= burn_time else x0 + vx * burn_time * np.cos(phi0),
            'y': lambda t: y0 + vx * t * np.sin(phi0) if t <= burn_time else y0 + vx * burn_time * np.sin(phi0),
            'z': lambda t: z0 + vz * t if t <= t_climb else r_target  # Coast to altitude, then hold
        }

        formulas = {
            'x': f"x0 + {vx:.2f} * t * cos({phi0:.2f}) if t <= {burn_time} else x0 + {vx * burn_time * np.cos(phi0):.2f}",
            'y': f"y0 + {vx:.2f} * t * sin({phi0:.2f}) if t <= {burn_time} else y0 + {vx * burn_time * np.sin(phi0):.2f}",
            'z': f"z0 + {vz:.2f} * t if t <= {t_climb:.2f} else {r_target:.2f}"
        }
        initial = {'x0': x0, 'y0': y0, 'z0': z0}
        return equations, t_climb, formulas, initial, v_orbit

# if __name__ == "__main__":
#     calc = TrajectoryCalculator()
#     eqns, t_cl, forms, init, v_orb = calc.calculate("Electron", 20000, (28.5, -80.5, 0))
#     print(f"Initial: {init}")
#     print(f"Formulas: {forms}")
#     print(f"t_climb: {t_cl:.2f}s")
#     print(f"Orbital Velocity: {v_orb:.2f} m/s")