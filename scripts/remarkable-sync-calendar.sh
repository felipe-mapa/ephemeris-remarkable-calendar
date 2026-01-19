#!/bin/bash

# Auto daily script for screen unlock trigger
# Only runs once per day to avoid multiple executions
# Generates and uploads the next 7 days with annotation preservation

# Always show a notification to validate it's running
TIMESTAMP=$(date '+%H:%M:%S')
osascript -e "display notification \"🔍 Checking at $TIMESTAMP\" with title \"Remarkable Sync Calendar\" subtitle \"Running validation check\""

# Use absolute paths to avoid permission issues
SCRIPT_DIR="/Users/felipepavanela/Documents/Dev/ephemeris-remarkable-calendar/scripts"
EPHEMERIS_SCRIPT="$SCRIPT_DIR/ephemeris.sh"

# Check if already run today
TODAY=$(date +%Y-%m-%d)
MARKER_FILE="/tmp/ephemeris_run_$TODAY"

if [ -f "$MARKER_FILE" ]; then
    echo "📅 Ephermeris already run today, skipping..."
    osascript -e 'display notification "📅 Already synced today" with title "Remarkable Sync Calendar" subtitle "Will run again tomorrow"'
    exit 0
fi

# Create marker file
touch "$MARKER_FILE"

echo "📅 Generating calendar for next 7 days (unlock trigger)..."
cd "$SCRIPT_DIR" || exit 1
./ephemeris.sh generate 7
./ephemeris.sh upload

# Show success notification
osascript -e 'display notification "✅ Calendar synced to reMarkable" with title "Remarkable Sync Calendar" subtitle "Next 7 days generated and uploaded"'
