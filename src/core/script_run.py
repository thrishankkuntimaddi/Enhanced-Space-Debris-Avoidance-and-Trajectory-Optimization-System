# debug_csv.py
with open("/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/rocket_parameters.csv", 'r') as f:
    print("First 5 lines:")
    for i, line in enumerate(f.readlines()[:5], 1):
        print(f"Line {i}: {line.strip()}")