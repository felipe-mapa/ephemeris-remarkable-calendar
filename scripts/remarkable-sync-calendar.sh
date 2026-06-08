#!/bin/bash

# Daily calendar sync script
# Downloads backup, regenerates calendar from database, merges annotations, and uploads

# Source shared functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers/functions.sh"

# Setup common paths
setup_common_paths "$SCRIPT_DIR"

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

# Parse arguments
SKIP_FETCH=false
for arg in "$@"; do
    case "$arg" in
        --skip-fetch)
            SKIP_FETCH=true
            ;;
    esac
done

# Get current year for document name
YEAR=$(date +%Y)
DOC_NAME="Calendar $YEAR"

# Step 1: Fetch new events from calendars and store in database
if [ "$SKIP_FETCH" = true ]; then
    log_with_timestamp "⏭️  Skipping calendar fetch (--skip-fetch), using existing database"
else
    log_with_timestamp "📅 Fetching events for next 7 days..."
    cd "$SCRIPT_DIR" || exit 1
    if ! ./ephemeris.sh generate 7; then
        log_with_timestamp "❌ ERROR: Failed to fetch calendar events"
        osascript -e 'display notification "❌ Failed to fetch calendar events" with title "Remarkable Sync Calendar Error" subtitle "Generate command failed"'
        exit 1
    fi
    log_with_timestamp "✅ Events fetched and stored in database"
fi

# Step 2: Download current calendar backup from reMarkable
log_with_timestamp "📥 Downloading backup from reMarkable..."

# Call the common backup function
BACKUP_FILENAME=$(backup_from_remarkable "$DOC_NAME" "$BACKUP_DIR" "$CONFIG_PATH")

if [ $? -eq 0 ] && [ -n "$BACKUP_FILENAME" ]; then
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
    # No live backup downloaded — try latest local backup before falling back to fresh upload
    LATEST_LOCAL_BACKUP=$(ls -t "$BACKUP_DIR"/Calendar\ ${YEAR}_*.rmdoc 2>/dev/null | head -1)
    if [ -n "$LATEST_LOCAL_BACKUP" ]; then
        log_with_timestamp "⚠️  Live backup unavailable, using local backup: $(basename "$LATEST_LOCAL_BACKUP")"
        cd "$PROJECT_ROOT" || exit 1
        if ./ephemeris/ephemeris_merge_from_backup.py --backup "$LATEST_LOCAL_BACKUP"; then
            log_with_timestamp "✅ Calendar merged and uploaded from local backup"
        else
            log_with_timestamp "❌ ERROR: Failed to merge from local backup"
            osascript -e 'display notification "❌ Failed to merge from local backup" with title "Remarkable Sync Calendar Error" subtitle "Merge from backup failed"' 2>/dev/null || true
            exit 1
        fi
    else
        # No backup at all — upload a fresh PDF
        log_with_timestamp "⚠️  No backup found, uploading fresh calendar..."
        cd "$SCRIPT_DIR" || exit 1
        if ./ephemeris.sh upload; then
            log_with_timestamp "✅ Fresh calendar uploaded"
        else
            log_with_timestamp "❌ ERROR: Failed to upload calendar"
            osascript -e 'display notification "❌ Failed to upload calendar" with title "Remarkable Sync Calendar Error" subtitle "Upload command failed"' 2>/dev/null || true
            exit 1
        fi
    fi
fi

log_with_timestamp "✅ Calendar sync completed"

# Show success notification
osascript -e 'display notification "✅ Calendar synced to reMarkable" with title "Remarkable Sync Calendar" subtitle "Calendar updated with annotations preserved"'
log_with_timestamp "🎉 Script completed successfully"