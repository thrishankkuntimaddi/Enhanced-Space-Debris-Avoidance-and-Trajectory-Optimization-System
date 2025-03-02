import os
import pandas as pd
import re


def advanced_preprocess_tle(lines):
    lines = [line.strip() for line in lines if line.strip() and not line.startswith('#')]
    processed_lines = []
    i = 0
    while i < len(lines):
        if i + 1 < len(lines) and re.match(r'^1 ', lines[i]) and re.match(r'^2 ', lines[i + 1]):
            processed_lines.append(lines[i])
            processed_lines.append(lines[i + 1])
            i += 2
        else:
            i += 1
    return processed_lines


def preprocess_and_format_tle(input_txt_path, output_csv_path):
    if not os.path.exists(input_txt_path):
        raise FileNotFoundError(f"Input file {input_txt_path} not found.")
    with open(input_txt_path, 'r') as file:
        lines = file.readlines()
    lines = advanced_preprocess_tle(lines)
    if not lines:
        raise ValueError("No valid TLE pairs found.")

    data = []
    for i in range(0, len(lines), 2):
        if i + 1 < len(lines):
            line1 = lines[i].strip()
            line2 = lines[i + 1].strip()
            sat_num = line1[2:7].strip()
            if not sat_num.isdigit():
                continue

            line1_data = [
                line1[0], sat_num, line1[9:17].strip(), line1[18:32].strip(),
                line1[33:43].strip(), line1[44:52].strip(), line1[53:61].strip(),
                line1[62:63].strip(), line1[64:68].strip()
            ]
            line2_data = [
                line2[0], line2[2:7].strip(), line2[8:16].strip(), line2[17:25].strip(),
                line2[26:33].strip(), line2[34:42].strip(), line2[43:51].strip(),
                line2[52:63].strip(), line2[63:68].strip()
            ]
            data.append(line1_data + line2_data)

    columns = [
        'Line1_Num', 'Satellite_Num', 'Intl_Designator', 'Epoch_Year_Day', 'First_Derivative',
        'Second_Derivative', 'BSTAR', 'Ephemeris_Type', 'Element_Set_Num',
        'Line2_Num', 'Satellite_Num_2', 'Inclination_deg', 'RAAN_deg', 'Eccentricity',
        'Arg_of_Perigee_deg', 'Mean_Anomaly_deg', 'Mean_Motion', 'Rev_at_Epoch'
    ]

    tle_df = pd.DataFrame(data, columns=columns)
    os.makedirs(os.path.dirname(output_csv_path), exist_ok=True)
    tle_df.to_csv(output_csv_path, index=False)
    print(f"CSV saved: {output_csv_path} ({len(tle_df)} entries)")


if __name__ == "__main__":
    input_path = "/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/inputs/tle_raw.txt"
    output_path = "/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/tle_data.csv"
    preprocess_and_format_tle(input_path, output_path)