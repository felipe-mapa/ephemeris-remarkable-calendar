#!/bin/bash

# Backup reMarkable Calendar Document
# Downloads the current calendar .rmdoc file from reMarkable cloud
# Usage: ./backup-calendar.sh [document_name]
# If document name is not provided, uses "Calendar [current_year]"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="$PROJECT_ROOT/backups"
CONFIG_PATH="$PROJECT_ROOT/config/.rmapi"

# Get document name from argument or use default
DOC_NAME=${1:-"Calendar $(date +%Y)"}

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Generate timestamp for backup filename
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILENAME="${DOC_NAME}_${TIMESTAMP}.rmdoc"

echo "=== Ephemeris Calendar Backup ==="
echo "Document: $DOC_NAME"
echo "Backup location: $BACKUP_DIR"
echo ""

# Check if config exists
if [ ! -d "$CONFIG_PATH" ]; then
    echo "❌ Error: rmapi config not found at $CONFIG_PATH"
    echo "Please run rmapi authentication first."
    exit 1
fi

# List available documents to help user
echo "Available documents on reMarkable:"
docker run --rm \
    -v "$CONFIG_PATH:/root/.config/rmapi" \
    ghcr.io/rmitchellscott/ephemeris:main-rmapi0.0.32 \
    rmapi ls
echo ""

# Download the document using rmapi in Docker
echo "Downloading $DOC_NAME from reMarkable..."
docker run --rm \
    -v "$CONFIG_PATH:/root/.config/rmapi" \
    -v "$BACKUP_DIR:/backup" \
    ghcr.io/rmitchellscott/ephemeris:main-rmapi0.0.32 \
    rmapi get "$DOC_NAME" -o "/backup/$BACKUP_FILENAME"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Backup successful!"
    echo "📁 Saved to: $BACKUP_DIR/$BACKUP_FILENAME"
    
    # Show backup file size
    if [ -f "$BACKUP_DIR/$BACKUP_FILENAME" ]; then
        SIZE=$(du -h "$BACKUP_DIR/$BACKUP_FILENAME" | cut -f1)
        echo "📊 File size: $SIZE"
    fi
else
    echo ""
    echo "❌ Backup failed!"
    echo "💡 Please check your reMarkable connection and document name."
    exit 1
fi
