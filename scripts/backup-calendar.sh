#!/bin/bash

# Backup reMarkable Calendar Document
# Downloads the current calendar .rmdoc file from reMarkable cloud
# Usage: ./backup-calendar.sh [document_name]
# If document name is not provided, uses "Calendar [current_year]"

set -e

# Source shared functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers/functions.sh"

# Setup common paths
setup_common_paths "$SCRIPT_DIR"

# Get document name from argument or use default
DOC_NAME=${1:-"Calendar $(date +%Y)"}

echo "=== Ephemeris Calendar Backup ==="
echo "Document: $DOC_NAME"
echo "Backup location: $BACKUP_DIR"
echo ""

log_with_timestamp "🔍 Starting calendar backup for $DOC_NAME"

# Check if config exists
if [ ! -d "$CONFIG_PATH" ]; then
    echo "❌ Error: rmapi config not found at $CONFIG_PATH"
    echo "Please run rmapi authentication first."
    log_with_timestamp "❌ ERROR: rmapi config not found at $CONFIG_PATH"
    osascript -e 'display notification "❌ rmapi config not found" with title "Calendar Backup Error" subtitle "Please run rmapi authentication first"'
    exit 1
fi

# List available documents to help user
echo "Available documents on reMarkable:"
docker run --rm \
    -v "$CONFIG_PATH:/root/.config/rmapi" \
    "$RMAPI_IMAGE" \
    rmapi ls
echo ""

# Call the shared backup function
echo "Downloading $DOC_NAME from reMarkable..."
log_with_timestamp "📥 Downloading $DOC_NAME from reMarkable..."
BACKUP_FILENAME=$(backup_from_remarkable "$DOC_NAME" "$BACKUP_DIR" "$CONFIG_PATH")

if [ $? -eq 0 ] && [ -n "$BACKUP_FILENAME" ]; then
    echo ""
    echo "✅ Backup successful!"
    echo "📁 Saved to: $BACKUP_DIR/$BACKUP_FILENAME"
    
    # Show backup file size
    SIZE=$(du -h "$BACKUP_DIR/$BACKUP_FILENAME" | cut -f1)
    echo "📊 File size: $SIZE"
    echo ""
    echo "🎉 Backup completed successfully"
    
    log_with_timestamp "✅ Backup completed: $BACKUP_FILENAME ($SIZE)"
    osascript -e 'display notification "✅ Calendar backup completed" with title "Calendar Backup" subtitle "Saved to backups folder"'
else
    echo ""
    echo "❌ Backup failed!"
    echo "💡 Please check your reMarkable connection and document name."
    
    log_with_timestamp "❌ ERROR: Backup failed for $DOC_NAME"
    osascript -e 'display notification "❌ Calendar backup failed" with title "Calendar Backup Error" subtitle "Please check reMarkable connection"'
    exit 1
fi
