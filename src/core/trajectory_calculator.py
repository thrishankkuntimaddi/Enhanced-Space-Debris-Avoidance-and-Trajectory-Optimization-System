# src/core/trajectory_calculator.py
import numpy as np
from scipy.optimize import fsolve
import pandas as pd

class TrajectoryCalculator:
    def __init__(self):
        self.R = 6371e3
        self.GM = 3.986e14
        self.g0 = 9.81
        self.rocket_data = pd.read_csv("/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/rocket_parameters.csv")

    def calculate(self, rocket_type, altitude_km, initial_position):
        altitude = altitude_km * 1000
        r_target = self.R + altitude
        v_orbit = np.sqrt(self.GM / r_target)  # 3074 m/s for GEO

        rocket = self.rocket_data[self.rocket_data['Rocket_Type'] == rocket_type].iloc[0]
        m0 = rocket['Mass_kg']
        thrust = rocket['Thrust_N']
        burn_time = rocket['Burn_Time_s']
        isp = 311
        mdot = thrust / (isp * self.g0)
        m_fuel = mdot * burn_time
        m_dry = m0 - m_fuel if m0 > m_fuel else m0 * 0.4
        pitch = np.radians(rocket['Launch_Angle_theta_deg'])
        phi0 = np.radians(rocket['Inclination_Angle_phi_deg'])

        lat0, lon0, z0_init = initial_position
        x0 = self.R * np.cos(np.radians(lat0)) * np.cos(np.radians(lon0))
        y0 = self.R * np.cos(np.radians(lat0)) * np.sin(np.radians(lon0))
        z0 = self.R * np.sin(np.radians(lat0))

        def mass(t):
            return m0 - mdot * t if t <= burn_time else m_dry

        def accel(t, r):
            if t <= burn_time:
                a = thrust / mass(t)
                g = -self.GM / (r**2)
                return {
                    'x': a * np.cos(pitch) * np.cos(phi0) + g * (x0 / r),
                    'y': a * np.cos(pitch) * np.sin(phi0) + g * (y0 / r),
                    'z': a * np.sin(pitch) + g * (z0 / r)
                }
            return {'x': 0, 'y': 0, 'z': -self.GM / (r**2)}

        def position(t, axis, x0=x0, y0=y0, z0=z0):
            a0 = accel(0, self.R)[axis]
            if t <= burn_time:
                return eval(f"{axis}0 + 0.5 * a0 * t**2")
            else:
                v_burn_end = a0 * burn_time
                t_coast = t - burn_time
                r_at_burn_end = np.sqrt(position(burn_time, 'x')**2 + position(burn_time, 'y')**2 + position(burn_time, 'z')**2)
                pos_burn_end = eval(f"{axis}0 + 0.5 * a0 * burn_time**2")
                g_coast = -self.GM / (r_at_burn_end**2)
                return pos_burn_end + v_burn_end * t_coast + 0.5 * g_coast * t_coast**2

        def z_target(t):
            return position(t, 'z') - r_target

        # Smarter guess for GEO
        az0 = accel(0, self.R)['z']
        vz_burn_end = az0 * burn_time
        z_burn_end = z0 + 0.5 * az0 * burn_time**2
        t_coast_guess = (r_target - z_burn_end) / (vz_burn_end - 0.5 * self.GM / (self.R + z_burn_end - z0)**2)
        t_guess = burn_time + t_coast_guess

        t_climb = fsolve(z_target, t_guess, xtol=1e-6, maxfev=1000)[0]
        z_final = position(t_climb, 'z')
        if not np.isclose(z_final, r_target, rtol=1e-3):
            t_climb = fsolve(z_target, t_climb * 1.1, xtol=1e-6, maxfev=1000)[0]

        # Adjust velocity to orbit
        r_final = np.sqrt(position(t_climb, 'x')**2 + position(t_climb, 'y')**2 + position(t_climb, 'z')**2)
        v_burn_x = accel(0, self.R)['x'] * burn_time
        v_burn_y = accel(0, self.R)['y'] * burn_time
        v_scale = v_orbit / np.sqrt(v_burn_x**2 + v_burn_y**2)  # Scale lateral to orbit speed

        equations = {
            'x': lambda t: (
                position(t, 'x') if t <= t_climb else
                position(t_climb, 'x') + v_orbit * (t - t_climb) * np.cos(phi0 + np.pi/2)
            ),
            'y': lambda t: (
                position(t, 'y') if t <= t_climb else
                position(t_climb, 'y') + v_orbit * (t - t_climb) * np.sin(phi0 + np.pi/2)
            ),
            'z': lambda t: position(t, 'z') if t <= t_climb else r_target
        }

        ax0, ay0, az0 = accel(0, self.R)['x'], accel(0, self.R)['y'], accel(0, self.R)['z']
        x_burn_end, y_burn_end, z_burn_end = position(burn_time, 'x'), position(burn_time, 'y'), position(burn_time, 'z')
        formulas = {
            'x': f"x0 + {0.5 * ax0:.2f}t² if t ≤ {burn_time} else x0 + {x_burn_end - x0:.0f} + {v_burn_x:.0f}(t - {burn_time}) + gravity if t ≤ {t_climb:.0f} else orbit at {v_orbit:.0f} m/s",
            'y': f"y0 + {0.5 * ay0:.2f}t² if t ≤ {burn_time} else y0 + {y_burn_end - y0:.0f} + {v_burn_y:.0f}(t - {burn_time}) + gravity if t ≤ {t_climb:.0f} else orbit at {v_orbit:.0f} m/s",
            'z': f"z0 + {0.5 * az0:.2f}t² if t ≤ {burn_time} else z0 + {z_burn_end - z0:.0f} + {vz_burn_end:.0f}(t - {burn_time}) + gravity if t ≤ {t_climb:.0f} else {r_target:.0f}"
        }
        initial = {'x0': x0, 'y0': y0, 'z0': z0}
        return equations, t_climb, formulas, initial, v_orbit, burn_time