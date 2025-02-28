class OrbitSelector:
    def __init__(self):
        self.orbit = None

    def select_orbit(self):
        print("Choose the type of orbit for your rocket launch:")
        print("\t1. Low Earth Orbit (LEO)")
        print("\t2. Medium Earth Orbit (MEO)")
        print("\t3. Geostationary Orbit (GEO)")
        print("\t4. High Earth Orbit (HEO)")

        choice = input("Enter the number of your choice (1-4): ")

        if choice == "1":
            self.orbit = {
                "name": "Low Earth Orbit (LEO)",
                "altitude_range": (200, 2000),
                "typical_uses": ["Earth observation", "Science missions", "Communication (low latency)", "International Space Station"]
            }
        elif choice == "2":
            self.orbit = {
                "name": "Medium Earth Orbit (MEO)",
                "altitude_range": (2000, 35786),
                "typical_uses": ["Navigation (e.g., GPS)", "Communication (global coverage)"]
            }
        elif choice == "3":
            self.orbit = {
                "name": "Geostationary Orbit (GEO)",
                "altitude": 35786,
                "typical_uses": ["Weather monitoring", "Satellite TV", "Communication (stationary over equator)"]
            }
        elif choice == "4":
            self.orbit = {
                "name": "High Earth Orbit (HEO)",
                "altitude_range": (35787, 50000),
                "typical_uses": ["Space observation", "Scientific missions", "Communication (beyond GEO)"]
            }
        else:
            print("Invalid choice. Please select a number between 1 and 4.")
            return self.select_orbit()

        self.display_orbit_details()
        altitude, altitude_range = self.select_altitude()
        return altitude, altitude_range, self.orbit['name']

    def display_orbit_details(self):
        print("\nYou have selected:")
        print(f"\tOrbit: {self.orbit['name']}")
        if 'altitude_range' in self.orbit:
            print(f"\tAltitude Range: {self.orbit['altitude_range'][0]} - {self.orbit['altitude_range'][1]} km")
        else:
            print(f"\tAltitude: {self.orbit['altitude']} km")
        print("\tTypical Uses:")
        for use in self.orbit["typical_uses"]:
            print(f"\t\t- {use}")

    def select_altitude(self):
        if 'altitude_range' in self.orbit:
            return self.get_altitude_in_range()
        else:
            print(f"You have selected the fixed altitude of {self.orbit['altitude']} km for the {self.orbit['name']}")
            return self.orbit['altitude'], [self.orbit['altitude'], self.orbit['altitude']]

    def get_altitude_in_range(self):
        while True:
            try:
                altitude = int(input(f"\nEnter a specific altitude within the range {self.orbit['altitude_range'][0]} - {self.orbit['altitude_range'][1]} km: "))
                if self.orbit['altitude_range'][0] <= altitude <= self.orbit['altitude_range'][1]:
                    print(f"You have selected an altitude of {altitude} km for the {self.orbit['name']}")
                    return altitude, list(self.orbit['altitude_range'])
                else:
                    print("Invalid altitude. Please enter a value within the specified range.")
            except ValueError:
                print("Invalid input. Please enter a numeric value.")
