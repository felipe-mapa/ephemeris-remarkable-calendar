#!/bin/bash

# Auto daily script for screen unlock trigger
# Only runs once per day to avoid multiple executions
# Generates and uploads the next 7 days with annotation preservation

# Logging function with timestamp (logs only)
log_with_timestamp() {
    local SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
    local LOG_FILE="$PROJECT_ROOT/logs/remarkable-sync.log"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Create logs directory if it doesn't exist
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOGS_DIR"

# Always show a notification to validate it's running
TIMESTAMP=$(date '+%H:%M:%S')
log_with_timestamp "🔍 Starting remarkable sync calendar check"

# Use relative paths based on script location
EPHEMERIS_SCRIPT="$SCRIPT_DIR/ephemeris.sh"

# Check if already run today
TODAY=$(date +%Y-%m-%d)
MARKER_FILE="$LOGS_DIR/ephemeris_run_$TODAY"

if [ -f "$MARKER_FILE" ]; then
    log_with_timestamp "📅 Ephemeris already run today, skipping..."
    exit 0
fi

log_with_timestamp "📅 Generating calendar for next 7 days (unlock trigger)..."
cd "$SCRIPT_DIR" || exit 1
log_with_timestamp "📅 Running: ./ephemeris.sh generate 7"
if ! ./ephemeris.sh generate 7; then
    log_with_timestamp "❌ ERROR: Failed to generate calendar"
    osascript -e 'display notification "❌ Failed to generate calendar" with title "Remarkable Sync Calendar Error" subtitle "Generate command failed"'
    exit 1
fi

log_with_timestamp "📅 Running: ./ephemeris.sh upload"
if ! ./ephemeris.sh upload; then
    log_with_timestamp "❌ ERROR: Failed to upload calendar"
    osascript -e 'display notification "❌ Failed to upload calendar" with title "Remarkable Sync Calendar Error" subtitle "Upload command failed"'
    exit 1
fi
log_with_timestamp "✅ Calendar generation and upload completed"

# Show success notification
log_with_timestamp "✅ Sending success notification"
osascript -e 'display notification "✅ Calendar synced to reMarkable" with title "Remarkable Sync Calendar" subtitle "Next 7 days generated and uploaded"'
log_with_timestamp "🎉 Script completed successfully"

# Create marker file only if success
touch "$MARKER_FILE"
log_with_timestamp "📅 Created daily marker file: $MARKER_FILE"