import re
import os
from typing import List, Tuple, Generator


def clean_and_validate_tle_lines(lines: List[str]) -> Generator[Tuple[str, str], None, None]:
    """
    Clean TLE text lines and yield valid Line 1 and Line 2 pairs.
    Args:
        lines: List of raw TLE text lines.
    Yields:
        Tuple[str, str]: (Line 1, Line 2) pairs.
    """
    lines = [line.strip() for line in lines if line.strip() and not line.startswith('#')]
    i = 0
    while i < len(lines) - 1:
        line1, line2 = lines[i], lines[i + 1]
        if (re.match(r'^1 ', line1) and re.match(r'^2 ', line2) and
                len(line1) == 69 and len(line2) == 69):
            yield line1, line2
        else:
            print(f"Warning: Skipping invalid pair at index {i}: {line1[:20]}... {line2[:20]}...")
        i += 2
    if i < len(lines):
        print(f"Warning: Incomplete pair at end: {lines[i][:20]}...")


def preprocess_and_save_tle(input_txt_path: str, output_txt_path: str):
    """
    Preprocess TLE text file and save cleaned pairs to output text file.
    Args:
        input_txt_path: Path to raw TLE input file.
        output_txt_path: Path to cleaned TLE output file.
    """
    if not os.path.exists(input_txt_path):
        raise FileNotFoundError(f"Input file not found at {input_txt_path}")

    with open(input_txt_path, 'r') as infile:
        lines = infile.readlines()

    valid_pairs = list(clean_and_validate_tle_lines(lines))
    if not valid_pairs:
        raise ValueError("No valid TLE pairs found in input file.")

    os.makedirs(os.path.dirname(output_txt_path), exist_ok=True)
    with open(output_txt_path, 'w') as outfile:
        for line1, line2 in valid_pairs:
            outfile.write(f"{line1}\n{line2}\n")

    print(f"Cleaned TLE data saved to {output_txt_path} ({len(valid_pairs)} pairs)")


if __name__ == "__main__":
    input_path = "/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/inputs/tle_raw.txt"
    output_path = "/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/tle_data.txt"
    preprocess_and_save_tle(input_path, output_path)