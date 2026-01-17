#!/bin/bash

# Auto daily script - can be used with cron or launchd
# Generates and uploads the next 30 days with annotation preservation

cd "$(dirname "$0")"
./ephemeris.sh generate 30
./ephemeris.sh upload
