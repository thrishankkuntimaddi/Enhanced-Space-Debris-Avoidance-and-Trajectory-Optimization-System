from datetime import datetime, timedelta
import pandas as pd
import os


class TimestampSelector:
    def __init__(self, tle_data_path="/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/tle_data.csv"):
        self.default_timestamp = datetime.now().replace(microsecond=0)
        self.tle_data_path = tle_data_path
        self.epoch_start = self._get_tle_epoch_start()
        self.epoch_end = self.epoch_start + timedelta(days=7)
        print(f"TLE epoch start: {self.epoch_start}")
        print(f"Valid timestamp range: {self.epoch_start} to {self.epoch_end}")

    def _get_tle_epoch_start(self):
        """Extract the earliest epoch from TLE data and convert to datetime."""
        if not os.path.exists(self.tle_data_path):
            raise FileNotFoundError(f"TLE data file not found at {self.tle_data_path}")

        tle_df = pd.read_csv(self.tle_data_path)
        if 'Epoch_Year_Day' not in tle_df.columns:
            raise ValueError("TLE data missing 'Epoch_Year_Day' column")

        # Convert epoch (e.g., 25057.47232210) to datetime
        epochs = tle_df['Epoch_Year_Day'].astype(float)
        earliest_epoch = epochs.min()
        year = int(f"20{str(int(earliest_epoch))[:2]}")  # e.g., "25" → 2025
        day_fraction = earliest_epoch % 1000  # e.g., 57.47232210
        base_date = datetime(year, 1, 1)  # Jan 1, 2025
        epoch_date = base_date + timedelta(days=day_fraction - 1)  # Day 57 = Feb 26
        return epoch_date.replace(microsecond=0)

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