#!/bin/bash

# Ephemeris Calendar Management Script
# Commands: init, refresh, upload

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/../output"
VENV_PYTHON="$SCRIPT_DIR/../venv/bin/python3"
DEFAULT_DAYS=30

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  init <year>      Initialize calendar for year (fetch all events, generate PDF)"
    echo "  refresh [days]   Refresh next N days (default: $DEFAULT_DAYS)"
    echo "  upload           Upload existing PDF to reMarkable"
    echo ""
    echo "Examples:"
    echo "  $0 init 2026"
    echo "  $0 refresh 14"
    echo "  $0 upload"
}

# Fetch events and save to database
fetch_events() {
    local start_date=$1
    local end_date=$2
    
    echo -e "${YELLOW}Fetching events from $start_date to $end_date...${NC}"
    "$VENV_PYTHON" "$SCRIPT_DIR/../ephemeris/event_fetcher.py" "$start_date" "$end_date"
}

# Generate PDF from database
generate_pdf() {
    local year=$1
    local output_file=$2
    
    echo -e "${YELLOW}Generating PDF for $year...${NC}"
    
    # Set environment variables for ephemeris.py
    export TIME_DATE_RANGE="$year-01-01:$year-12-31"
    export APP_OUTPUT_PDF_PATH="$SCRIPT_DIR/../output/$output_file"
    export APP_FORCE_REFRESH="true"
    
    # Run the main ephemeris script (loads from calendar.db)
    "$VENV_PYTHON" "$SCRIPT_DIR/../ephemeris.py"
}

# Clear events for date range
clear_events() {
    local start_date=$1
    local end_date=$2
    
    "$VENV_PYTHON" "$SCRIPT_DIR/../ephemeris/calendar_db_sqlite.py" clear_range "$start_date" "$end_date"
}

# Upload to reMarkable
upload_to_remarkable() {
    local file_path=$1
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local year=$(basename "$file_path" | grep -o '[0-9]\{4\}')
    local temp_file="$script_dir/../output/Calendar ${year}.pdf"
    
    echo -e "${YELLOW}Uploading to reMarkable using Docker...${NC}"
    
    # Copy file with correct name
    cp "$file_path" "$temp_file"
    
    # Use Docker image with rmapi included
    # Upload with the correct name
    docker run --rm \
        -v "$script_dir/../output:/app/output" \
        -v "$script_dir/../config/.rmapi:/root/.config/rmapi" \
        ghcr.io/rmitchellscott/ephemeris:main-rmapi0.0.32 \
        rmapi put --force "/app/output/Calendar ${year}.pdf"
    
    # Clean up temporary file
    rm -f "$temp_file"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Upload complete!${NC}"
    else
        echo -e "${RED}Upload failed. Please check your rmapi configuration in config/.rmapi${NC}"
        exit 1
    fi
}

# Main command handling
if [ $# -lt 1 ]; then
    usage
    exit 1
fi

COMMAND=$1
shift

case $COMMAND in
    init)
        if [ $# -lt 1 ]; then
            YEAR=$(date +%Y)
        else
            YEAR=$1
        fi
        
        echo -e "${GREEN}Initializing calendar for $YEAR...${NC}"
        
        # Clear existing events for the year
        "$VENV_PYTHON" "$SCRIPT_DIR/../ephemeris/calendar_db_sqlite.py" clear_all
        
        # Fetch all events for the year
        fetch_events "$YEAR-01-01" "$YEAR-12-31"
        
        # Generate PDF
        generate_pdf "$YEAR" "calendar_$YEAR.pdf"
        
        echo -e "${GREEN}✅ Calendar $YEAR initialized successfully!${NC}"
        ;;
        
    refresh)
        DAYS=${1:-$DEFAULT_DAYS}
        YEAR=$(date +%Y)
        START_DATE=$(date +"%Y-%m-%d")
        END_DATE=$(date -v+${DAYS}d +"%Y-%m-%d" 2>/dev/null || date -d "+${DAYS} days" +"%Y-%m-%d")
        
        echo -e "${GREEN}Refreshing calendar for next $DAYS days...${NC}"
        
        # Clear events for the refresh period
        clear_events "$START_DATE" "$END_DATE"
        
        # Fetch new events for the period
        fetch_events "$START_DATE" "$END_DATE"
        
        # Regenerate the full year PDF
        generate_pdf "$YEAR" "calendar_$YEAR.pdf"
        
        echo -e "${GREEN}✅ Calendar refreshed successfully!${NC}"
        ;;
        
    upload)
        YEAR=$(date +%Y)
        PDF_FILE="$OUTPUT_DIR/calendar_$YEAR.pdf"
        
        if [ ! -f "$PDF_FILE" ]; then
            echo -e "${RED}Error: Calendar PDF not found at $PDF_FILE${NC}"
            echo -e "${YELLOW}Run './ephemeris.sh init $YEAR' first${NC}"
            exit 1
        fi
        
        upload_to_remarkable "$PDF_FILE"
        
        echo -e "${GREEN}✅ Calendar uploaded!${NC}"
        ;;
        
    *)
        echo -e "${RED}Unknown command: $COMMAND${NC}"
        usage
        exit 1
        ;;
esac
