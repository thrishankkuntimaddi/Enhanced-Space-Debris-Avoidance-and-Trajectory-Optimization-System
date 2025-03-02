class OrbitSelector:
    def __init__(self):
        self.orbit_types = {
            1: {"type": "LEO", "name": "Low Earth Orbit (LEO)", "range": (200, 2000)},
            2: {"type": "MEO", "name": "Medium Earth Orbit (MEO)", "range": (2000, 35786)},
            3: {"type": "GEO", "name": "Geostationary Orbit (GEO)", "range": (35786, 35786)},
            4: {"type": "HEO", "name": "High Earth Orbit (HEO)", "range": (35787, 50000)}
        }

    def display_options(self):
        """Show available orbit types and ranges."""
        print("Choose your orbit type:")
        for key, orbit in self.orbit_types.items():
            if orbit["range"][0] == orbit["range"][1]:
                print(f"{key}. {orbit['name']} (Fixed at {orbit['range'][0]} km)")
            else:
                print(f"{key}. {orbit['name']} ({orbit['range'][0]} - {orbit['range'][1]} km)")

    def get_orbit_choice(self):
        """Prompt user for orbit type."""
        while True:
            self.display_options()
            try:
                choice = int(input("Enter your choice (1-4): "))
                if choice in self.orbit_types:
                    return choice
                print("Invalid choice. Select 1-4.")
            except ValueError:
                print("Please enter a number (1-4).")

    def get_altitude(self, orbit_choice):
        """Prompt user for altitude within the selected orbit's range."""
        orbit = self.orbit_types[orbit_choice]
        min_alt, max_alt = orbit["range"]

        if min_alt == max_alt:  # GEO is fixed
            print(f"{orbit['name']} altitude is fixed at {min_alt} km")
            return min_alt

        while True:
            try:
                altitude = int(input(f"Enter target altitude ({min_alt} - {max_alt} km): "))
                if min_alt <= altitude <= max_alt:
                    print(f"Selected altitude: {altitude} km")
                    return altitude
                print(f"Altitude must be between {min_alt} and {max_alt} km.")
            except ValueError:
                print("Please enter a valid number.")

    def run(self):
        """Execute orbit selection."""
        choice = self.get_orbit_choice()
        altitude = self.get_altitude(choice)
        orbit_type = self.orbit_types[choice]["type"]
        return altitude, orbit_type


# if __name__ == "__main__":
#     selector = OrbitSelector()
#     altitude, orbit_type = selector.run()
#     print(f"Final selection: {orbit_type} at {altitude} km")