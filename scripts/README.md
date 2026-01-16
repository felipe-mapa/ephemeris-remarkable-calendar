# Ephemeris Scripts

This folder contains organized scripts for generating and managing your reMarkable calendar PDFs.

## Main Script

### `ephemeris.sh` - All-in-one script

The primary script that handles all calendar operations.

**Basic Usage:**

```bash
# Initialize base calendar for the year
./ephemeris.sh init

# Generate next 30 days and upload to reMarkable
./ephemeris.sh upload

# Generate today only
./ephemeris.sh today

# Generate current week
./ephemeris.sh week

# Generate next 60 days and append to base
./ephemeris.sh append 60
```

**Advanced Options:**

```bash
# Use different timezone
./ephemeris.sh upload -t America/New_York

# Custom hours (9 AM to 6 PM)
./ephemeris.sh upload -s 9 -e 18

# Initialize for a specific year
./ephemeris.sh init 2025
```

## Legacy Scripts (kept for reference)

-   `init_base_calendar.sh` - Initialize full year calendar
-   `run_rm2.sh` - Basic generation script
-   `run_rm2_smart.sh` - Fixed 30-day range
-   `run_rm2_dynamic.sh` - Dynamic date calculation
-   `run_rm2_with_upload.sh` - Docker with rmapi included
-   `daily_sync.sh` - Simple daily sync script

## File Structure

```
Ephemeris/
├── scripts/
│   ├── ephemeris.sh          # Main script (use this!)
│   ├── README.md             # This file
│   └── [legacy scripts]      # Old scripts
├── output/
│   ├── ephemeris.pdf         # Final combined calendar
│   └── ephemeris_base.pdf    # Base year calendar
├── config.yaml               # Calendar configuration
└── feeds_meta.yaml           # Change detection metadata
```

## Quick Start

1. **First time setup:**

    ```bash
    cd scripts
    ./ephemeris.sh init
    ```

2. **Daily use:**

    ```bash
    ./ephemeris.sh upload
    ```

3. **Custom needs:**
    ```bash
    ./ephemeris.sh append 90  # Add next 90 days
    ```

## Notes

-   The main script handles all Docker commands internally
-   Change detection is automatic - runs are fast when no events changed
-   All times are in your configured timezone (default: Pacific/Auckland)
-   Output is optimized for reMarkable 2 (1404x1872, 226 DPI)
