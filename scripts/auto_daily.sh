#!/bin/bash

# Auto daily script - can be used with cron or launchd
# Generates and uploads the next 30 days with annotation preservation

cd "$(dirname "$0")"

echo "📅 Generating calendar for next 7 days..."
./ephemeris.sh generate 7
./ephemeris.sh upload
