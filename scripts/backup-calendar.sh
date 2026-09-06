#!/bin/bash
# Backup reMarkable Calendar Document (thin wrapper around the TypeScript CLI in app/)
# Usage: ./backup-calendar.sh [document_name]   (default: "Calendar <current year>")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/../app"
if (cd "$APP_DIR" && npm run --silent cli -- backup "$@"); then
    osascript -e 'display notification "✅ Calendar backup completed" with title "Calendar Backup" subtitle "Saved to backups folder"' 2>/dev/null || true
else
    osascript -e 'display notification "❌ Calendar backup failed" with title "Calendar Backup Error" subtitle "Please check reMarkable connection"' 2>/dev/null || true
    exit 1
fi
