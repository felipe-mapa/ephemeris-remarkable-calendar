#!/bin/bash

# Daily calendar sync script
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

# Lock file to prevent concurrent executions
LOCK_FILE="$LOGS_DIR/ephemeris_sync.lock"

# Check if script is already running
if [ -f "$LOCK_FILE" ]; then
    # Check if the process is actually running
    LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "Script already running (PID: $LOCK_PID), skipping..."
        log_with_timestamp "⚠️  Script already running (PID: $LOCK_PID), skipping..."
        exit 0
    else
        # Stale lock file, remove it
        log_with_timestamp "🧹 Removing stale lock file"
        rm -f "$LOCK_FILE"
    fi
fi

# Create lock file with current PID
echo $$ > "$LOCK_FILE"

# Ensure lock file is removed on exit
trap "rm -f '$LOCK_FILE'" EXIT INT TERM

log_with_timestamp "🔍 Starting remarkable sync calendar"

# Use relative paths based on script location
EPHEMERIS_SCRIPT="$SCRIPT_DIR/ephemeris.sh"

log_with_timestamp "📅 Generating calendar for next 7 days..."
log_with_timestamp "📅 Running: ./ephemeris.sh generate 7"
cd "$SCRIPT_DIR" || exit 1
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