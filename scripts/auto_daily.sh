#!/bin/bash

# Auto daily script - can be used with cron or launchd
# Generates and uploads the next 30 days

cd "$(dirname "$0")"
./ephemeris.sh upload
