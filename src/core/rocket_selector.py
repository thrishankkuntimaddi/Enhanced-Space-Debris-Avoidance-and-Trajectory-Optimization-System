import pandas as pd
import os

class RocketSelector:
    def __init__(self, data_path="/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/rocket_parameters.csv"):
        self.data_path = data_path
        if not os.path.exists(data_path):
            raise FileNotFoundError(f"Rocket parameters file not found at {data_path}")
        self.rockets_df = pd.read_csv(data_path)

    def filter_rockets(self, altitude, orbit_type):
        """Filter rockets based on altitude and orbit type."""
        filtered = self.rockets_df[
            (self.rockets_df['Max_Altitude_km'] >= altitude) &
            (self.rockets_df['Type_of_Orbit'] == orbit_type)
        ]
        if filtered.empty:
            raise ValueError(f"No rockets available for {orbit_type} at {altitude} km")
        return filtered

    def display_options(self, filtered_rockets):
        """Show available rockets to the user."""
        print(f"\nAvailable rockets for {filtered_rockets['Type_of_Orbit'].iloc[0]} at {filtered_rockets['Max_Altitude_km'].min()} km or higher:")
        count = 0
        for i, row in filtered_rockets.iterrows():
            count+=1
            print(f"{count}. {row['Rocket_Type']} (Launch Site: {row['Launch_Site']})")

    def get_rocket_choice(self, filtered_rockets):
        """Prompt user to select a rocket."""
        while True:
            self.display_options(filtered_rockets)
            try:
                choice = int(input("Enter your rocket choice (number): "))
                if 1 <= choice <= len(filtered_rockets):
                    selected_row = filtered_rockets.iloc[choice - 1]
                    print(f"Selected rocket: {selected_row['Rocket_Type']} from {selected_row['Launch_Site']}")
                    return selected_row
                print(f"Please select a number between 1 and {len(filtered_rockets)}")
            except ValueError:
                print("Please enter a valid number")

    def run(self, altitude, orbit_type):
        """Execute rocket selection."""
        filtered_rockets = self.filter_rockets(altitude, orbit_type)
        selected_rocket = self.get_rocket_choice(filtered_rockets)
        return {
            'rocket_type': selected_rocket['Rocket_Type'],
            'launch_site': selected_rocket['Launch_Site'],
            'coordinates': selected_rocket['Launch_Site_Coordinates_(x0;y0;z0)']
        }

# if __name__ == "__main__":
#     selector = RocketSelector()
#     # Example: LEO at 500 km
#     result = selector.run(500, "LEO")
#     print(f"Final selection: {result['rocket_type']} from {result['launch_site']} at {result['coordinates']}")