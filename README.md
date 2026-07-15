# Ephemeris - reMarkable Calendar Generator

A clean, minimalist calendar generator for the reMarkable tablet with interactive year view and daily pages.

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

- **Year calendar**: Edit `ephemeris/year_calendar.py`
- **Daily pages**: Edit `ephemeris/renderers.py`
- **Settings**: Edit `ephemeris/settings.py`

Common changes:

```python
# Year title size
font_size = 44

# Month spacing
month_gap_h = 12
month_gap_v = 12
```

## Upload Any File to reMarkable

Upload any PDF (or other file) directly to your reMarkable:

```bash
# Upload to reMarkable root
python upload_to_remarkable.py ~/Documents/notes.pdf

# Upload to a specific folder on the device
python upload_to_remarkable.py report.pdf --dest "/My Folder"
```

### Finder Right-Click Quick Action (macOS)

Add an "Upload to reMarkable" option to the Finder right-click menu:

1. Open **Automator** → New Document → **Quick Action**

2. At the top of the workflow, set:
   - **Workflow receives current** → `files or folders`
   - **in** → `Finder`

3. Search for **"Run Shell Script"** in the action library and drag it into the workflow

4. Set **Pass input** → `as arguments`

5. Paste this script (update the path if your project lives elsewhere):
   ```bash
   PROJECT="/Users/felipepavanela/Documents/Dev/ephemeris-remarkable-calendar"
   LOG="$PROJECT/logs/upload-quick-action.log"
   mkdir -p "$PROJECT/logs"

   osascript -e 'display notification "Starting upload..." with title "reMarkable"'

   while IFS= read -r f; do
       [[ -z "$f" ]] && continue
       filename=$(basename "$f")
       echo "Uploading: $f" >> "$LOG"

       if "$PROJECT/venv/bin/python3" "$PROJECT/upload_to_remarkable.py" "$f" >> "$LOG" 2>&1; then
           osascript -e "display notification \"\\\"$filename\\\" uploaded successfully!\" with title \"reMarkable\""
       else
           osascript -e "display notification \"Failed to upload \\\"$filename\\\"\" with title \"reMarkable\""
       fi
   done
   ```

6. Save (`Cmd+S`) → name it **"Upload to reMarkable"**

Right-click any file in Finder → **Quick Actions** → **Upload to reMarkable**. Logs are written to `logs/upload-quick-action.log`.

## Automation

### Daily Sync with macOS Shortcuts (Recommended)

Set up automatic daily calendar sync using macOS Shortcuts:

1. **Open Shortcuts app** (macOS Monterey or later)

2. **Create new shortcut** named "Ephemeris Daily Sync"
   - Add action: **Run Shell Script**
   - Paste this script:
     ```bash
     {root_path_to_project}/ephemeris-remarkable-calendar/scripts/remarkable-sync-calendar.sh
     ```
   - Add action: **Show Notification** (optional)
     - Title: `Ephemeris Sync Complete`
     - Body: `Calendar synced to reMarkable`

3. **Create automation**
   - Go to **Automation** tab in Shortcuts
   - Click **+** → **Personal Automation**
   - Select **Time of Day** → Choose your preferred time (e.g., 9:00 AM)
   - Set to repeat: **Daily**
   - Add action: **Run Shortcut** → Select "Ephemeris Daily Sync"
   - **Disable** "Ask Before Running"

This will:
- Run once daily at your chosen time
- Generate and upload the next 7 days of calendar with annotation preservation
- Show notification when complete
- Log all activity to `logs/remarkable-sync.log`

### Alternative: Calendar Alarm

If you prefer using Calendar app:

1. **Create Automator Application**
   - Open **Automator** → New **Application**
   - Add action: **Run Shell Script**
     ```bash
     /Users/felipepavanela/Documents/Dev/ephemeris-remarkable-calendar/scripts/remarkable-sync-calendar.sh
     ```
   - Save as `EphemerisSync.app` in `~/Applications/`

2. **Set up Calendar alarm**
   - Open **Calendar** app
   - Create new event: "Ephemeris Sync"
   - Set to repeat: **Daily** at your preferred time
   - Add alert: **Custom** → **Open file** → Select `EphemerisSync.app`

### Manual Scripts

You can also run these scripts manually:

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

#### Annotation preservation

```bash
# Preserve annotations when updating calendar (downloads from reMarkable)
./ephemeris/ephemeris_merge_annotations.py

# Regenerate PDF from database and merge with backup annotations
./ephemeris/ephemeris_merge_from_backup.py

# List available backup files
./ephemeris/ephemeris_merge_from_backup.py --list-backups

# Use specific backup file
./ephemeris/ephemeris_merge_from_backup.py --backup "backups/Calendar 2026_20260202_093512.rmdoc"

# Skip upload (just create merged .rmdoc)
./ephemeris/ephemeris_merge_from_backup.py --no-upload
```

#### Database management

```bash
# View database statistics
python3 ephemeris/calendar_db_sqlite.py stats

# Export all events from database
python3 ephemeris/calendar_db_sqlite.py export

# Database backups are automatically created in backups/db/
```

## Troubleshooting

- **Fonts not loading**: Check `fonts/` directory
- **Upload fails**:
    - Install and configure `rmapi` in `config/.rmapi`
    - Ensure Docker is installed and running
    - Check internet connection
- **No events**: Verify calendar URLs in config
- **Automation not running**:
    - **Shortcuts**: Check Automation tab → Verify automation is enabled and "Ask Before Running" is disabled
    - **Calendar Alarm**: Ensure Calendar has permission to run applications in System Settings → Privacy & Security → Automation
    - Check logs: `tail -f logs/remarkable-sync.log`
- **Multiple daily runs**:
    - Check marker file: `ls -la logs/ephemeris_run_$(date +%Y-%m-%d)`
    - Manually delete marker file to force run: `rm logs/ephemeris_run_$(date +%Y-%m-%d)`
- **Script fails when run manually**:
    - Ensure you're in the project directory or use absolute paths
    - Check script permissions: `chmod +x scripts/*.sh`
- **Backup merge script fails**:
    - Make script executable: `chmod +x ephemeris/ephemeris_merge_from_backup.py`
    - Check backup directory: `ls -la backups/`
    - Ensure new calendar PDF exists: `ls -la output/calendar_*.pdf`

## License

MIT License
