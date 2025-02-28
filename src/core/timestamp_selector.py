from datetime import datetime

class TimestampSelector:
    def __init__(self):
        self.timestamp = datetime.now().replace(microsecond=0)
        print(f"Current Timestamp: {self.timestamp}")

    def get_timestamp(self):
        while True:
            combined_str = input("Enter Date and Time (YYYY-MM-DD HH:MM:SS) [Press Enter to use current timestamp]: ") or self.timestamp.strftime("%Y-%m-%d %H:%M:%S")
            try:
                self.timestamp = datetime.strptime(combined_str, "%Y-%m-%d %H:%M:%S")
                # print(f"Selected Timestamp: {self.timestamp}")
                break
            except ValueError:
                print("Invalid date or time format. Please try again.")

    def run(self):
        self.get_timestamp()
        return self.timestamp