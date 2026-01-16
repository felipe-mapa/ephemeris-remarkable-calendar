# Ephemeris Setup Guide

## Overview

Ephemeris generates clean daily schedules from your Google Calendar for e-ink devices like reMarkable 2.

## Prerequisites

-   Docker installed and running
-   Google Calendar private ICS link

## Configuration Files

### 1. `config/config.yaml`

Configure your calendars:

```yaml
calendars:
    - name: TC
      source: https://calendar.google.com/calendar/ical/felipe%40theconqueror.com/private-XXXX/basic.ics
      color: gray4
```

### 2. `config/.rmapi/`

reMarkable API credentials (auto-created, private)

### 3. `feeds_meta.yaml`

Metadata file for change detection (auto-created).

### Calendar Colors

Supported values for colors are:

-   CSS color names (e.g., `blue`, `red`, `green`)
-   Hex colors (e.g., `#FF5733`)
-   Grayscale values: `gray1` through `gray14` (4-bit grayscale steps)

Example:

```yaml
calendars:
    - name: Personal
      source: calendars/personal.ics
      color: gray8
    - name: Work
      source: calendars/work
      color: #4287f5
    - name: Holidays
      source: https://example.com/holidays.ics
      color: red
```

## Running Ephemeris

### Quick Start (Recommended)

```bash
cd scripts
./ephemeris.sh init          # Create base calendar
./ephemeris.sh upload        # Generate and upload
```

### Manual Docker Command

```bash
docker run --rm \
  -v "$(pwd)/calendars:/app/calendars" \
  -v "$(pwd)/output:/app/output" \
  -v "$(pwd)/config/config.yaml:/app/config.yaml" \
  -v "$(pwd)/feeds_meta.yaml:/app/feeds_meta.yaml" \
  -e TZ=Pacific/Auckland \
  -e TIME_DATE_RANGE=today \
  -e DOC_PAGE_DIMENSIONS=1404x1872 \
  -e DOC_PAGE_DPI=226 \
  ghcr.io/rmitchellscott/ephemeris
```

## Scripts

### `scripts/ephemeris.sh` - Main Script

All-in-one script for calendar operations:

-   `./ephemeris.sh init` - Create base calendar
-   `./ephemeris.sh upload` - Generate & upload next 30 days
-   `./ephemeris.sh append [days]` - Add days to base calendar
-   `./ephemeris.sh today/week/month` - Generate specific ranges

### `scripts/auto_daily.sh`

Automated daily sync for cron/launchd (optional)

## Output

-   PDF generated in `output/ephemeris.pdf`
-   Ready for transfer to reMarkable 2

## reMarkable 2 Setup

### Device Parameters

#### reMarkable 2

```bash
DOC_PAGE_DIMENSIONS=1404x1872
DOC_PAGE_DPI=226
```

### Uploading to reMarkable 2

#### Option 1: Using rmapi (Recommended)

1. Install rmapi:
    ```bash
    brew install rmapi  # macOS
    ```
2. Configure rmapi:
    ```bash
    rmapi
    # Enter your reMarkable credentials
    ```
3. Upload automatically with the script:
    ```bash
    ./ephemeris.sh upload
    ```

#### Option 2: Docker with bundled rmapi

Use the special Docker image that includes rmapi:

```bash
docker run --rm \
  -v "$(pwd)/calendars:/app/calendars" \
  -v "$(pwd)/output:/app/output" \
  -v "$(pwd)/config/config.yaml:/app/config.yaml" \
  -v "$(pwd)/feeds_meta.yaml:/app/feeds_meta.yaml" \
  -v "$(pwd)/config/.rmapi:/root/.config/rmapi" \
  -e TZ=Pacific/Auckland \
  -e TIME_DATE_RANGE=today \
  -e DOC_PAGE_DIMENSIONS=1404x1872 \
  -e DOC_PAGE_DPI=226 \
  -e APP_POST_HOOK="rmapi put output/ephemeris.pdf /Ephemeris/" \
  ghcr.io/rmitchellscott/ephemeris:main-rmapi0.0.32
```

#### Option 3: Manual Transfer to reMarkable 2

1. **Desktop App**: Drag `output/ephemeris.pdf` to your reMarkable 2
2. **Email**: Send to your reMarkable email address
3. **USB**: Connect reMarkable 2 via USB cable

## Docker Setup

### Docker Compose

```yaml
services:
    ephemeris:
        image: ghcr.io/rmitchellscott/ephemeris
        volumes:
            - ./calendars:/app/calendars
            - ./output:/app/output
            - ./config/config.yaml:/app/config.yaml
            - ./feeds_meta.yaml:/app/feeds_meta.yaml # Used for change detection
        environment:
            - TZ=America/Denver
            - TIME_DATE_RANGE=week
```

### Docker Commands

```shell
# Standard version (default)
docker run --rm \
  -v "$(pwd)/calendars:/app/calendars" \
  -v "$(pwd)/output:/app/output" \
  -v "$(pwd)/config/config.yaml:/app/config.yaml" \
  -v "$(pwd)/feeds_meta.yaml:/app/feeds_meta.yaml" \
  -e TZ=America/Denver \
  -e TIME_DATE_RANGE=week \
  ghcr.io/rmitchellscott/ephemeris

# Version with rmapi bundled
docker run --rm \
  -v "$(pwd)/calendars:/app/calendars" \
  -v "$(pwd)/output:/app/output" \
  -v "$(pwd)/config/config.yaml:/app/config.yaml" \
  -v "$(pwd)/feeds_meta.yaml:/app/feeds_meta.yaml" \
  -v "$(pwd)/config/.rmapi:/root/.config/rmapi" \
  -e TZ=America/Denver \
  -e TIME_DATE_RANGE=week \
  ghcr.io/rmitchellscott/ephemeris:main-rmapi0.0.32

# Build locally
# Standard version (without rmapi)
docker build --target ephemeris -t ephemeris .

# Version with rmapi (default build)
docker build -t ephemeris-rmapi .
```

### Python Setup

#### Requirements

-   Python 3.8+
-   Dependencies: `cairosvg`, `icalendar`, `loguru`, `pypdf`, `pytz`, `pyyaml`, `reportlab`, `requests`, `webcolors`

Install dependencies with:

```bash
pip install -r requirements.txt
```

Run the script:

```bash
python ephemeris.py
```

## Environment Variables

| Variable              | Default         | Description                                                                      |
| --------------------- | --------------- | -------------------------------------------------------------------------------- |
| `TIME_DATE_RANGE`     | `today`         | Date range to generate (e.g., `today`, `week`, `month`, `2024-01-01:2024-01-31`) |
| `TIME_DISPLAY_START`  | `0`             | Start hour to display events                                                     |
| `TIME_DISPLAY_END`    | `23`            | End hour to display events                                                       |
| `TZ`                  | `UTC`           | Timezone for event times                                                         |
| `DOC_PAGE_DIMENSIONS` | `1404x1872`     | Page dimensions in pixels (reMarkable 2)                                         |
| `DOC_PAGE_DPI`        | `226`           | DPI for rendering (reMarkable 2)                                                 |
| `APP_FORCE_REFRESH`   | `false`         | Force regeneration even if unchanged                                             |
| `APP_OUTPUT_PDF_PATH` | `ephemeris.pdf` | Output PDF filename                                                              |

## Layout Options

Ephemeris supports different layout styles:

-   **Default**: Traditional calendar with time slots
-   **Center Calendar**: Calendar centered on page with events below
-   **Grid Only**: Just the calendar grid, no events
-   **Grid All-Day**: Grid with all-day events section

Configure via the `DOC_LAYOUT` environment variable.

## Troubleshooting

-   Ensure Docker is running
-   Check calendar URL is private (not public)
-   Verify timezone setting matches your location
