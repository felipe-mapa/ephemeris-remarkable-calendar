#!/bin/bash

# Year calendar test script - generates only the year calendar page
# Usage: ./generate_year_calendar.sh [year]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PYTHON="$SCRIPT_DIR/../venv/bin/python"

# Default to 2026 if no year provided
YEAR=${1:-2026}

# Color codes for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Generating year calendar for $YEAR...${NC}"

# Create a temporary Python script that uses ONLY year_calendar.py
cat > "$SCRIPT_DIR/../generate_year_only.py" << 'EOF'
import os
import sys
from datetime import date, datetime
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import black

# Add ephemeris to path
sys.path.insert(0, str(Path(__file__).parent))

from ephemeris.fonts import init_fonts
from ephemeris.renderers import get_page_size
from ephemeris.year_calendar import render_year_calendar

def main():
    year = int(os.getenv("TEST_YEAR", "2026"))
    output_path = os.getenv("TEST_OUTPUT_PATH", "output/year_calendar_test.pdf")
    
    # Initialize fonts
    init_fonts()
    
    # Create output directory
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    # Get page size
    width, height = get_page_size()
    
    # Create canvas
    c = canvas.Canvas(output_path, pagesize=(width, height))
    c.setAuthor("Ephemeris - Year Calendar Test")
    
    # Add bookmark for the cover page
    c.bookmarkPage("cover")
    
    # Render year calendar using the EXACT same function as the main calendar
    print(f"Rendering year calendar for {year}...")
    # Pass empty date list so no clickable links are created
    render_year_calendar(c, year, [], width, height)
    
    # Save PDF
    c.save()
    print(f"Year calendar saved to: {output_path}")

if __name__ == "__main__":
    main()
EOF

# Set environment variables
export TEST_YEAR="$YEAR"
export TEST_OUTPUT_PATH="$SCRIPT_DIR/../output/year_calendar_$YEAR.pdf"

# Run the year calendar generator
"$VENV_PYTHON" "$SCRIPT_DIR/../generate_year_only.py"

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Year calendar generated successfully!${NC}"
    echo -e "Output: $SCRIPT_DIR/../output/year_calendar_$YEAR.pdf"
    echo ""
    echo "To open it (macOS):"
    echo "  open $SCRIPT_DIR/../output/year_calendar_$YEAR.pdf"
else
    echo -e "${YELLOW}❌ Failed to generate year calendar${NC}"
    exit 1
fi

# Clean up temporary script
rm -f "$SCRIPT_DIR/../generate_year_only.py"
