#!/bin/bash

# Daily calendar sync script
# Downloads backup, regenerates calendar from database, merges annotations, and uploads

# Logging function with timestamp (logs only)
log_with_timestamp() {
    local LOG_FILE="$LOGS_DIR/remarkable-sync.log"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Create logs directory if it doesn't exist
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="$PROJECT_ROOT/logs"
BACKUP_DIR="$PROJECT_ROOT/backups"
CONFIG_PATH="$PROJECT_ROOT/config/.rmapi"
mkdir -p "$LOGS_DIR"
mkdir -p "$BACKUP_DIR"

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

# Get current year for document name
YEAR=$(date +%Y)
DOC_NAME="Calendar $YEAR"

# Step 1: Fetch new events from calendars and store in database
log_with_timestamp "📅 Fetching events for next 7 days..."
cd "$SCRIPT_DIR" || exit 1
if ! ./ephemeris.sh generate 7; then
    log_with_timestamp "❌ ERROR: Failed to fetch calendar events"
    osascript -e 'display notification "❌ Failed to fetch calendar events" with title "Remarkable Sync Calendar Error" subtitle "Generate command failed"'
    exit 1
fi
log_with_timestamp "✅ Events fetched and stored in database"

# Step 2: Download current calendar backup from reMarkable
log_with_timestamp "📥 Downloading backup from reMarkable..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILENAME="${DOC_NAME}_${TIMESTAMP}.rmdoc"

docker run --rm \
    -v "$CONFIG_PATH:/root/.config/rmapi" \
    -v "$BACKUP_DIR:/backup" \
    ghcr.io/rmitchellscott/ephemeris:main-rmapi0.0.32 \
    rmapi get "$DOC_NAME" -o "/backup/$BACKUP_FILENAME" 2>&1 | grep -v "^$" || true

if [ -f "$BACKUP_DIR/$BACKUP_FILENAME" ]; then
    log_with_timestamp "✅ Backup downloaded: $BACKUP_FILENAME"
    
    # Step 3: Regenerate PDF from database and merge with backup annotations
    log_with_timestamp "🔄 Regenerating calendar and merging annotations..."
    cd "$PROJECT_ROOT" || exit 1
    if ./ephemeris/ephemeris_merge_from_backup.py --backup "$BACKUP_DIR/$BACKUP_FILENAME"; then
        log_with_timestamp "✅ Calendar merged and uploaded"
    else
        log_with_timestamp "❌ ERROR: Failed to merge calendar"
        osascript -e 'display notification "❌ Failed to merge calendar" with title "Remarkable Sync Calendar Error" subtitle "Merge command failed"' 2>/dev/null || true
        exit 1
    fi
else
    # No backup exists yet, just upload the fresh PDF
    log_with_timestamp "⚠️  No existing backup found, uploading fresh calendar..."
    cd "$SCRIPT_DIR" || exit 1
    if ./ephemeris.sh upload; then
        log_with_timestamp "✅ Fresh calendar uploaded"
    else
        log_with_timestamp "❌ ERROR: Failed to upload calendar"
        osascript -e 'display notification "❌ Failed to upload calendar" with title "Remarkable Sync Calendar Error" subtitle "Upload command failed"' 2>/dev/null || true
        exit 1
    fi
fi

log_with_timestamp "✅ Calendar sync completed"

# Show success notification
osascript -e 'display notification "✅ Calendar synced to reMarkable" with title "Remarkable Sync Calendar" subtitle "Calendar updated with annotations preserved"'
log_with_timestamp "🎉 Script completed successfully"