#!/bin/bash

# Find the project root by looking for the scripts directory and ephemeris.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Verify we're in the right place
if [ ! -f "$SCRIPT_DIR/ephemeris.sh" ]; then
    echo "Error: ephemeris.sh not found in $SCRIPT_DIR"
    exit 1
fi

# Change to scripts directory and run the main script
cd "$SCRIPT_DIR" || exit 1
exec ./remarkable-sync-calendar.sh
