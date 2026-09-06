#!/bin/bash
# Daily calendar sync (thin wrapper around the TypeScript CLI in app/).
# Fetches events, downloads the device backup, merges annotations and uploads.
# Usage: ./remarkable-sync-calendar.sh [--skip-fetch]
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/../app"
# Shortcuts/Automator run with a minimal PATH; make sure node, npm and docker are reachable.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"

if (cd "$APP_DIR" && npm run --silent cli -- sync "$@"); then
    osascript -e 'display notification "✅ Calendar synced to reMarkable" with title "Remarkable Sync Calendar" subtitle "Calendar updated with annotations preserved"' 2>/dev/null || true
    exit 0
else
    osascript -e 'display notification "❌ Calendar sync failed" with title "Remarkable Sync Calendar Error" subtitle "See logs/remarkable-sync.log"' 2>/dev/null || true
    exit 1
fi
