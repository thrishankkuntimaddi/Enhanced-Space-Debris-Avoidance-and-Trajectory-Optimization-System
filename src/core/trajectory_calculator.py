import numpy as np
import pandas as pd
import os


class TrajectoryCalculator:
    def __init__(self, data_path="/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/rocket_parameters.csv"):
        self.data_path = data_path
        if not os.path.exists(data_path):
            raise FileNotFoundError(f"Rocket parameters file not found at {data_path}")
        self.rockets_df = pd.read_csv(data_path)
        self.g = 9.81  # Gravity (m/s^2)

    def calculate(self, rocket_type, altitude, launch_coordinates):
        """Generate initial trajectory equations based on rocket parameters."""
        # Fetch rocket data
        rocket = self.rockets_df[self.rockets_df['Rocket_Type'] == rocket_type].iloc[0]

        # Extract parameters
        v0 = rocket['Initial_Velocity_v0_m_per_s']  # Orbital velocity (m/s)
        theta = np.radians(rocket['Launch_Angle_theta_deg'])  # Launch angle (radians)
        phi = np.radians(rocket['Inclination_Angle_phi_deg'])  # Inclination (radians)
        thrust = rocket['Thrust_N']  # Thrust (N)
        mass = rocket['Mass_kg']  # Dry mass (kg)
        burn_time = rocket['Burn_Time_s']  # Burn time (s)
        x0, y0, z0 = map(float, launch_coordinates.strip('()').split(';'))  # Starting coords

        # Acceleration from thrust (m/s^2)
        accel = thrust / mass - self.g

        # Time to reach altitude (simplified climb phase)
        t_climb = np.sqrt(2 * altitude * 1000 / accel)  # Convert km to m

        # Trajectory equations (parametric in time t)
        # x and y use horizontal velocity components, z uses thrust ascent
        equations = {
            'x': f"{x0} + {v0 * np.cos(theta) * np.cos(phi)} * t",
            'y': f"{y0} + {v0 * np.cos(theta) * np.sin(phi)} * t",
            'z': f"{z0} + {0.5 * accel} * t**2 if t <= {burn_time} else {0.5 * accel * burn_time ** 2}"
        }

        return equations, t_climb


# if __name__ == "__main__":
#     calc = TrajectoryCalculator()
#     # Example: Electron to 500 km from (-39.261;177.864;0)
#     equations, t_climb = calc.calculate("Electron", 500, "(-39.261;177.864;0)")
#     print(f"Trajectory equations: {equations}")
#     print(f"Time to altitude: {t_climb:.2f} seconds")