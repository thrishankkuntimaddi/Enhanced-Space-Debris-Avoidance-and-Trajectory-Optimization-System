import math
import numpy as np
import pandas as pd


class TrajectoryCalculator:
    def __init__(self,
                 dataset_path="/Users/thrishankkuntimaddi/Documents/Final_Year_Project/Space-Debris-and-Route-Calculation/data/rocket_parameters.csv"):
        """
        Initializes the TrajectoryCalculator with a dataset.

        Parameters:
        - dataset_path (str): The file path to the dataset containing rocket parameters.
        """
        self.dataset = pd.read_csv(dataset_path)

    def calculate_trajectory(self, rocket_type, launch_site, launch_site_coordinates, selected_altitude_to_reach):
        """
        Calculates the trajectory equation for a rocket to reach a specified altitude.

        Parameters:
        - rocket_type (str): The type of the rocket (e.g., 'Soyuz')
        - launch_site (str): Name of the launch site (e.g., 'Baikonur Cosmodrome')
        - launch_site_coordinates (str): Coordinates of the launch site in the format '(x0, y0, z0)' or '(x0, y0)'
        - selected_altitude_to_reach (float): The altitude to reach in kilometers from Earth's surface

        Returns:
        - dict: A dictionary with parametric trajectory equations as strings.
        """
        # Find the rocket data for the specified rocket type and launch site
        rocket_data = self.dataset[
            (self.dataset['Rocket_Type'].str.strip().str.lower() == rocket_type.strip().lower()) &
            (self.dataset['Launch_Site'].str.strip().str.lower() == launch_site.strip().lower())]

        if rocket_data.empty:
            return "Error: Rocket type or launch site not found in dataset."

        # Extract necessary parameters
        try:
            coordinates = launch_site_coordinates.strip('()').split(',')
            if len(coordinates) == 2:
                x0, y0 = map(float, coordinates)
                z0 = 0.0  # Default value for z if not provided
            elif len(coordinates) == 3:
                x0, y0, z0 = map(float, coordinates)
            else:
                return "Error: Invalid launch site coordinates format. Expected '(x0, y0)' or '(x0, y0, z0)'."
        except ValueError:
            return "Error: Invalid coordinate values. Please ensure they are numerical."

        try:
            v0 = float(rocket_data['Initial_Velocity_v0_m_per_s'].iloc[0])
        except (ValueError, KeyError):
            return "Error: Invalid or missing initial velocity in the dataset."

        theta = rocket_data['Launch_Angle_theta_deg'].iloc[0]
        phi = rocket_data['Inclination_Angle_phi_deg'].iloc[0]

        # Set default values if angles are not provided
        if pd.isna(theta):
            theta = 45.0  # Default launch angle in degrees
        if pd.isna(phi):
            phi = 0.0  # Default inclination angle in degrees

        # Convert angles to radians
        theta = math.radians(theta)
        phi = math.radians(phi)
        k = 0.1  # Constant controlling the rate of transition

        # Define the trajectory equations as strings
        trajectory_equations = {
            'x': f"x(t) = {x0} + {v0} * t * cos({theta}) * cos({phi})",
            'y': f"y(t) = {y0} + {v0} * t * cos({theta}) * sin({phi})",
            'z': f"z(t) = {z0} + {v0} * t * sin({theta})",
            'theta': f"theta(t) = {theta} * (1 - exp(-{k} * t))"
        }

        return trajectory_equations
