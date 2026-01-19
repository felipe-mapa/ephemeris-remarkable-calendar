#!/bin/bash

# Monitor for screen unlock events
# Runs the sync script when system wakes from sleep

cd "$(dirname "$0")"

LAST_SLEEP_FILE="/tmp/ephemeris_last_sleep"
SYNC_SCRIPT="./remarkable-sync-calendar.sh"

while true; do
    # Check current sleep state
    CURRENT_STATE=$(pmset -g | grep "sleep" | awk '{print $2}')
    
    # If we were asleep and now we're awake
    if [[ -f "$LAST_SLEEP_FILE" && "$CURRENT_STATE" == "0" ]]; then
        echo "🔓 System woke from sleep, triggering calendar sync..."
        "$SYNC_SCRIPT"
        rm "$LAST_SLEEP_FILE"
        sleep 300  # Wait 5 minutes after sync
    elif [[ "$CURRENT_STATE" == "1" ]]; then
        # System is going to sleep
        touch "$LAST_SLEEP_FILE"
    fi
    
    sleep 10  # Check every 10 seconds
done
