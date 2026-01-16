#!/usr/bin/env python3
"""
Generate calendar PDF from events in the database
Uses Docker to run the ephemeris container
"""

import os
import sys
import json
import subprocess
from datetime import datetime
import calendar_db_sqlite as calendar_db

# Configuration
TIMEZONE = "Pacific/Auckland"
START_HOUR = 8
END_HOUR = 19
OUTPUT_DIR = "../output"

def get_script_dir():
    """Get the directory containing this script"""
    return os.path.dirname(os.path.abspath(__file__))

def get_output_dir():
    """Get the absolute path to the output directory"""
    return os.path.join(get_script_dir(), OUTPUT_DIR)

def generate_pdf(year: int, output_filename: str = None):
    """Generate a PDF calendar for the entire year from the database"""
    
    if output_filename is None:
        output_filename = f"calendar_{year}.pdf"
    
    # Get all events from database
    all_events = calendar_db.get_all_events()
    
    # Create temporary events file for Docker
    output_dir = get_output_dir()
    os.makedirs(output_dir, exist_ok=True)
    
    temp_events_file = os.path.join(output_dir, f"events_{year}.json")
    with open(temp_events_file, 'w') as f:
        json.dump(all_events, f)
    
    # Date range for the year
    start_date = f"{year}-01-01"
    end_date = f"{year}-12-31"
    
    script_dir = get_script_dir()
    
    # Build Docker command
    cmd = [
        "docker", "run", "--rm",
        "-v", f"{script_dir}/../calendars:/app/calendars",
        "-v", f"{output_dir}:/app/output",
        "-v", f"{script_dir}/../config/config.yaml:/app/config.yaml",
        "-v", f"{script_dir}/../config/feeds_meta.yaml:/app/feeds_meta.yaml",
        "-e", f"TZ={TIMEZONE}",
        "-e", f"TIME_DATE_RANGE={start_date}:{end_date}",
        "-e", f"TIME_DISPLAY_START={START_HOUR}",
        "-e", f"TIME_DISPLAY_END={END_HOUR}",
        "-e", "DOC_PAGE_DIMENSIONS=1404x1872",
        "-e", "DOC_PAGE_DPI=226",
        "-e", "DOC_EVENT_FILL_COLOR=gray14",
        "-e", "DOC_EVENT_BORDER_COLOR=gray(20%)",
        "-e", "DOC_GRID_LINE_COLOR=gray(20%)",
        "-e", "DOC_FOOTER_COLOR=gray(60%)",
        "-e", "APP_FORCE_REFRESH=true",
        "-e", f"APP_OUTPUT_PDF_PATH=output/{output_filename}",
        "ghcr.io/rmitchellscott/ephemeris"
    ]
    
    print(f"Generating PDF for {year}...", file=sys.stderr)
    
    result = subprocess.run(cmd, capture_output=False)
    
    if result.returncode == 0:
        output_path = os.path.join(output_dir, output_filename)
        print(f"✅ PDF generated: {output_path}", file=sys.stderr)
        # Clean up temp file
        if os.path.exists(temp_events_file):
            os.remove(temp_events_file)
        return True
    else:
        print(f"❌ PDF generation failed", file=sys.stderr)
        return False

def main():
    if len(sys.argv) < 2:
        print("Usage: pdf_generator.py <year> [output_filename]")
        sys.exit(1)
    
    year = int(sys.argv[1])
    output_filename = sys.argv[2] if len(sys.argv) > 2 else None
    
    success = generate_pdf(year, output_filename)
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
