from datetime import datetime, timedelta
import os

class TimestampSelector:
    def __init__(self, tle_data_path="/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/tle_data.txt"):
        self.default_timestamp = datetime.now().replace(microsecond=0)
        self.tle_data_path = tle_data_path
        self.epoch_start = self._get_tle_epoch_start()
        self.epoch_end = self.epoch_start + timedelta(days=7)
        print(f"TLE epoch start: {self.epoch_start}")
        print(f"Valid timestamp range: {self.epoch_start} to {self.epoch_end}")

    def _get_tle_epoch_start(self):
        """Extract the earliest epoch from TLE text data and convert to datetime."""
        if not os.path.exists(self.tle_data_path):
            raise FileNotFoundError(f"TLE data file not found at {self.tle_data_path}")

        earliest_epoch = None
        with open(self.tle_data_path, 'r') as file:
            lines = file.readlines()
            for i in range(0, len(lines) - 1, 2):  # Step by 2 for Line 1, Line 2 pairs
                line1 = lines[i].strip()
                try:
                    # Extract epoch from Line 1, cols 18-32 (e.g., '25057.47232210')
                    epoch_str = line1[18:32].strip()
                    epoch_float = float(epoch_str)
                    year = int(f"20{str(int(epoch_float))[:2]}")  # e.g., '25' → 2025
                    day_fraction = epoch_float % 1000  # e.g., 57.47232210
                    base_date = datetime(year, 1, 1)
                    epoch_date = base_date + timedelta(days=day_fraction - 1)
                    if earliest_epoch is None or epoch_date < earliest_epoch:
                        earliest_epoch = epoch_date
                except (ValueError, IndexError) as e:
                    print(f"Warning: Skipping invalid epoch in TLE pair {line1[:20]}...: {e}")
                    continue

        if earliest_epoch is None:
            raise ValueError("No valid epochs found in TLE data")
        return earliest_epoch.replace(microsecond=0)

    def get_timestamp(self):
        """Prompt user for a timestamp within TLE's 7-day validity window."""
        while True:
            print(f"Enter launch timestamp (YYYY-MM-DD HH:MM:SS) between {self.epoch_start} and {self.epoch_end}")
            print("Or press Enter for default (TLE epoch start)")
            user_input = input(": ").strip()

            if not user_input:
                print(f"Using default timestamp: {self.epoch_start}")
                return self.epoch_start

            try:
                timestamp = datetime.strptime(user_input, "%Y-%m-%d %H:%M:%S")
                if self.epoch_start <= timestamp <= self.epoch_end:
                    print(f"Selected timestamp: {timestamp}")
                    return timestamp
                else:
                    print(f"Error: Timestamp must be between {self.epoch_start} and {self.epoch_end}")
            except ValueError:
                print("Invalid format. Use YYYY-MM-DD HH:MM:SS (e.g., 2025-03-01 12:00:00)")

    def run(self):
        """Execute timestamp selection."""
        return self.get_timestamp()

# if __name__ == "__main__":
#     selector = TimestampSelector()
#     selected_timestamp = selector.run()
#     print(f"Final selected timestamp: {selected_timestamp}")