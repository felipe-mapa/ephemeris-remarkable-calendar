# Ephemeris - reMarkable Calendar Generator

A clean, minimalist calendar generator for the reMarkable tablet with interactive year view and daily pages.

## Quick Start

```bash
# Clone and setup
git clone https://github.com/felipe-mapa/ephemeris-remarkable-calendar.git
cd ephemeris-remarkable-calendar/scripts
./ephemeris.sh init

# Generate calendar locally
./ephemeris.sh refresh

# Upload to reMarkable
./ephemeris.sh upload
```

## Installation

1. **Clone the repository**

    ```bash
    git clone https://github.com/felipe-mapa/ephemeris-remarkable-calendar.git
    cd ephemeris-remarkable-calendar
    ```

2. **Install dependencies**

    ```bash
    # Create and activate virtual environment
    python3 -m venv venv
    source venv/bin/activate
    
    # Install requirements
    pip install -r requirements.txt
    ```

3. **Generate calendar**

    ```bash
    cd scripts
    ./ephemeris.sh generate-full
    ```

4. **Configure calendars** (optional)
    - Edit `config/config.yaml` to add your calendar sources

## Commands

```bash
./ephemeris.sh generate 7        # Get calendar events for next 7 days and update year calendar PDF
./ephemeris.sh generate-full    # Generate calendar for entire year
./ephemeris.sh upload           # Upload existing PDF to reMarkable
```

## Test Scripts

Test calendar designs without fetching real events:

```bash
# Daily calendar with sample events
python ephemeris/test_design.py

# Daily calendar for specific date
python ephemeris/test_design.py --date 2026-01-20

# Empty daily calendar
python ephemeris/test_design.py --empty

# Year calendar
python ephemeris/test_design.py --year
python ephemeris/test_design.py --year 2026

# Custom output path
python ephemeris/test_design.py --output output/my_test.pdf
```

## Configuration

Edit `config/config.yaml`:

```yaml
calendars:
    - name: "Personal"
      type: "google"
      url: "https://calendar.google.com/calendar/ical/..."

layout:
    start_hour: 8
    end_hour: 20
```

## Customization

-   **Year calendar**: Edit `ephemeris/year_calendar.py`
-   **Daily pages**: Edit `ephemeris/renderers.py`
-   **Settings**: Edit `ephemeris/settings.py`

Common changes:

```python
# Year title size
font_size = 44

# Month spacing
month_gap_h = 12
month_gap_v = 12
```

## Automation

### Daily Sync on Unlock

Set up automatic calendar sync when you unlock your MacBook:

```bash
# Install the unlock trigger
cp scripts/com.ephemeris.remarkable-sync-calendar.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ephemeris.remarkable-sync-calendar.plist
```

This will:
- Run every 5 minutes but only execute once per day
- Generate and upload the next 7 days of calendar with annotation preservation
- Only run once per day (uses `logs/ephemeris_run_YYYY-MM-DD` marker)
- Show notifications for success/failure
- Log all activity to `logs/remarkable-sync.log`

To uninstall:
```bash
launchctl unload ~/Library/LaunchAgents/com.ephemeris.remarkable-sync-calendar.plist
launchctl remove com.ephemeris.remarkable-sync-calendar
rm ~/Library/LaunchAgents/com.ephemeris.remarkable-sync-calendar.plist
```

### Manual Scripts

The automation uses these scripts which can also be run manually:

#### Main automation script

```bash
./scripts/remarkable-sync-calendar.sh
```

#### Core ephemeris commands

```bash
./scripts/ephemeris.sh generate 7     # Generate next 7 days
./scripts/ephemeris.sh upload         # Upload to reMarkable
./scripts/ephemeris.sh generate-full  # Generate full year
```

## Troubleshooting

-   **Fonts not loading**: Check `fonts/` directory
-   **Upload fails**: 
    - Install and configure `rmapi` in `config/.rmapi`
    - Ensure Docker is installed and running
    - Check internet connection
-   **No events**: Verify calendar URLs in config
-   **Automation not running**:
    - Check if launch agent is loaded: `launchctl list | grep ephemeris`
    - Check logs: `tail -f logs/remarkable-sync.log`
    - Verify unlock trigger is enabled in System Settings → General → Login Items
-   **Multiple daily runs**:
    - Check marker file: `ls -la logs/ephemeris_run_$(date +%Y-%m-%d)`
    - Manually delete marker file to force run: `rm logs/ephemeris_run_$(date +%Y-%m-%d)`

## License

MIT License
