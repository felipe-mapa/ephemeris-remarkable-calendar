#!/bin/bash

# Shared functions for Ephemeris reMarkable scripts
# This file contains common functions used by multiple scripts

# Common function for reMarkable backup operations
backup_from_remarkable() {
    local DOC_NAME="$1"
    local BACKUP_DIR="$2"
    local CONFIG_PATH="$3"
    
    # Generate timestamp for backup filename
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_FILENAME="${DOC_NAME}_${TIMESTAMP}.rmdoc"
    TEMP_DOWNLOAD="$BACKUP_DIR/$DOC_NAME.rmdoc"
    
    # Download to default location, then rename with timestamp
    docker run --rm \
        -v "$CONFIG_PATH:/root/.config/rmapi" \
        -v "$BACKUP_DIR:/backup" \
        -w /backup \
        ghcr.io/rmitchellscott/ephemeris:main-rmapi0.0.32 \
        rmapi get "$DOC_NAME" >/dev/null 2>&1 || true
    
    # Check if download succeeded and rename with timestamp
    if [ -f "$TEMP_DOWNLOAD" ]; then
        mv "$TEMP_DOWNLOAD" "$BACKUP_DIR/$BACKUP_FILENAME"
        echo "$BACKUP_FILENAME"
        return 0
    else
        return 1
    fi
}

# Logging function with timestamp
log_with_timestamp() {
    local LOG_FILE="$LOGS_DIR/remarkable-sync.log"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Common path setup function
setup_common_paths() {
    local SCRIPT_DIR="$1"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    BACKUP_DIR="$PROJECT_ROOT/backups"
    CONFIG_PATH="$PROJECT_ROOT/config/.rmapi"
    LOGS_DIR="$PROJECT_ROOT/logs"
    
    # Create necessary directories
    mkdir -p "$BACKUP_DIR"
    mkdir -p "$LOGS_DIR"
    
    # Export variables for use by calling scripts
    export PROJECT_ROOT
    export BACKUP_DIR
    export CONFIG_PATH
    export LOGS_DIR
}
