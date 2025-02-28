import os
import pandas as pd
import numpy as np
import re


def advanced_preprocess_tle(lines):
    # Remove empty lines and comments
    lines = [line.strip() for line in lines if line.strip() and not line.startswith('#')]

    # Ensure that each TLE entry has two lines (Line 1 and Line 2)
    processed_lines = []
    i = 0
    while i < len(lines):
        if i + 1 < len(lines) and re.match(r'^1 ', lines[i]) and re.match(r'^2 ', lines[i + 1]):
            processed_lines.append(lines[i])
            processed_lines.append(lines[i + 1])
            i += 2
        else:
            # Skip invalid or incomplete entries
            i += 1

    return processed_lines


def preprocess_and_format_tle(input_txt_path, output_csv_path):
    # Load TLE text file
    with open(input_txt_path, 'r') as file:
        lines = file.readlines()

    # Advanced preprocessing to ensure no data loss
    lines = advanced_preprocess_tle(lines)

    # Process lines into structured data
    data = []
    for i in range(0, len(lines), 2):
        if i + 1 < len(lines):
            line1 = lines[i].strip()
            line2 = lines[i + 1].strip()

            # Parse line 1
            line1_data = [
                line1[0],  # Line number
                line1[2:7].strip(),  # Satellite number
                line1[9:17].strip(),  # International designator
                line1[18:32].strip(),  # Epoch year and day
                line1[33:43].strip(),  # First derivative of mean motion
                line1[44:52].strip(),  # Second derivative of mean motion
                line1[53:61].strip(),  # BSTAR drag term
                line1[62:63].strip(),  # Ephemeris type
                line1[64:68].strip(),  # Element set number
            ]

            # Parse line 2
            line2_data = [
                line2[0],  # Line number
                line2[2:7].strip(),  # Satellite number
                line2[8:16].strip(),  # Inclination (degrees)
                line2[17:25].strip(),  # RAAN (degrees)
                line2[26:33].strip(),  # Eccentricity (decimal)
                line2[34:42].strip(),  # Argument of perigee (degrees)
                line2[43:51].strip(),  # Mean anomaly (degrees)
                line2[52:63].strip(),  # Mean motion (revolutions per day)
                line2[63:68].strip(),  # Revolution number at epoch
            ]

            # Append parsed line data to main data list
            data.append(line1_data + line2_data)

    # Load existing CSV to retain column names if they exist
    if os.path.exists(output_csv_path):
        existing_df = pd.read_csv(output_csv_path)
        columns = existing_df.columns.tolist()
    else:
        # Define default column names
        columns = [
            'Line1_Num', 'Satellite_Num', 'Intl_Designator', 'Epoch_Year_Day', 'First_Derivative',
            'Second_Derivative', 'BSTAR', 'Ephemeris_Type', 'Element_Set_Num',
            'Line2_Num', 'Satellite_Num_2', 'Inclination_deg', 'RAAN_deg', 'Eccentricity',
            'Argument_of_Perigee_deg', 'Mean_Anomaly_deg', 'Mean_Motion', 'Rev_at_Epoch'
        ]

    # Convert to DataFrame
    tle_df = pd.DataFrame(data, columns=columns)

    # Save DataFrame to CSV
    tle_df.to_csv(output_csv_path, index=False)
    print(f"CSV file saved successfully at: {output_csv_path}")
