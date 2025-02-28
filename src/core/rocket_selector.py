import pandas as pd

class RocketSelector:
    def __init__(self, csv_path="/Users/thrishankkuntimaddi/Documents/Final_Year_Project/Space-Debris-and-Route-Calculation/data/rocket_parameters.csv"):
        # Load the rocket dataset from CSV
        self.rocket_df = pd.read_csv(csv_path)
        # Ensure Max_Altitude_km column is numeric
        self.rocket_df['Max_Altitude_km'] = pd.to_numeric(self.rocket_df['Max_Altitude_km'], errors='coerce')
        # Calculate the maximum possible altitude for any rocket
        self.max_possible_altitude = self.rocket_df['Max_Altitude_km'].max()

    def get_orbit_range(self, orbit_type):
        """
        Get the altitude range for a specific orbit type.
        """
        orbit_ranges = {
            'Low Earth Orbit (LEO)': [200, 2000],
            'Medium Earth Orbit (MEO)': [2000, 35785],
            'Geostationary Orbit (GEO)': [35786, 35786],
            'High Earth Orbit (HEO)': [35787, 50000]
        }
        return orbit_ranges.get(orbit_type, None)

    def get_rockets_for_orbit_and_altitude(self, target_altitude, orbit_type):
        """
        Get rockets capable of reaching the specified target altitude within the selected orbit type.
        """
        altitude_range = self.get_orbit_range(orbit_type)
        if altitude_range is None:
            return f"Invalid orbit type: {orbit_type}. Please choose a valid orbit type."

        min_range, max_range = altitude_range
        if not (min_range <= target_altitude <= max_range):
            return f"The selected altitude of {target_altitude} km is not within the specified range of {min_range} to {max_range} km for {orbit_type}. Please choose a valid altitude within the range."

        # Filter rockets that can reach the selected orbit type range
        rockets_in_orbit = self.rocket_df[(self.rocket_df['Max_Altitude_km'] >= min_range) & (self.rocket_df['Max_Altitude_km'] <= max_range)]

        # Further filter rockets that can reach the target altitude
        suitable_rockets = rockets_in_orbit[rockets_in_orbit['Max_Altitude_km'] >= target_altitude]

        if suitable_rockets.empty:
            if target_altitude > 20000 and orbit_type == 'Medium Earth Orbit (MEO)':
                return f"No rockets available for the specified target altitude of {target_altitude} km within the selected orbit type {orbit_type} as there are no rockets capable of reaching altitudes above 20000 km in MEO."
            return f"No rockets available for the specified target altitude of {target_altitude} km within the selected orbit type {orbit_type}."

        # Sort rockets by max altitude
        suitable_rockets = suitable_rockets.sort_values(by='Max_Altitude_km')

        # Prepare the result with required columns
        result = suitable_rockets[['Rocket_Type', 'Launch_Site', 'Launch_Site_Coordinates_latitude_and_longitude', 'Max_Altitude_km']].to_dict(orient='records')
        return result

    def check_rocket_criteria(self, target_altitude, orbit_type):
        """
        Allow the user to dynamically input rocket type based on the available rockets for the specified target altitude and orbit type.
        """
        # Get the list of rockets for the given target altitude and orbit type
        rockets_list = self.get_rockets_for_orbit_and_altitude(target_altitude, orbit_type)
        if isinstance(rockets_list, str):
            return rockets_list

        # Check if rockets are available
        if not rockets_list:
            return f"No rockets available for the specified target altitude of {target_altitude} km within the selected orbit type {orbit_type}."

        # Display available rockets
        if isinstance(rockets_list, list):
            print("\nAvailable rockets for the specified target altitude and orbit type:")
            for i, rocket in enumerate(rockets_list):
                print(f"{i + 1}: {rocket['Rocket_Type']}")

            # Allow user to select rocket type dynamically
            rocket_type = input("\nEnter the rocket type from the list above: ")

            # Filter rockets by the provided rocket type
            rocket = [r for r in rockets_list if r['Rocket_Type'] == rocket_type]
            if not rocket:
                return f"Rocket type '{rocket_type}' not found."

            # Output selected rocket details with additional orbit coordinates
            selected_orbit_coordinates = f"Coordinates for target altitude {target_altitude} km"
            rocket[0]['Selected_Orbit_Coordinates'] = selected_orbit_coordinates

            # Prepare summary output
            summary = {
                "Rocket_Type": rocket[0]['Rocket_Type'],
                "Launch_Site": rocket[0]['Launch_Site'],
                "Launch_Site_Coordinates": rocket[0]['Launch_Site_Coordinates_latitude_and_longitude'],
                "Orbit_Coordinates": rocket[0]['Selected_Orbit_Coordinates']
            }

            return summary

        return "No rockets available for the specified criteria."
