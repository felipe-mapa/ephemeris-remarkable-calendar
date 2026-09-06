#!/bin/bash
# reMarkableCalendar Management Script (thin wrapper around the TypeScript CLI in app/)
# Commands: generate [days], generate-full [year], upload
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/../app"
run_cli() { (cd "$APP_DIR" && npm run --silent cli -- "$@"); }

COMMAND=${1:-help}; shift || true
case "$COMMAND" in
    generate)       run_cli fetch "${1:-30}" && run_cli generate ;;
    generate-full)  run_cli fetch-year "${1:-$(date +%Y)}" && run_cli generate "${1:-$(date +%Y)}" ;;
    upload)         run_cli upload ;;
    *)
        echo "Usage: $0 <generate [days] | generate-full [year] | upload>"
        echo "See 'npm run cli -- help' in app/ for the full command set."
        [ "$COMMAND" = "help" ] && exit 0 || exit 1 ;;
esac
