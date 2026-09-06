# reMarkableCalendar - reMarkable Calendar Generator

A clean, minimalist calendar generator for the reMarkable tablet with interactive year view and daily pages.

## Installation

1. **Clone the repository**

    ```bash
    git clone https://github.com/felipe-mapa/reMarkableCalendar.git
    cd reMarkableCalendar
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
    ./remarkable_calendar.sh generate-full
    ```

4. **Configure calendars** (optional)
    - Edit `config/config.yaml` to add your calendar sources

## Web app

A local web app (TypeScript, React, React Router, Tailwind) wraps every script in one place: browse events month by month, remove events (soft delete, so they stay out of the PDF and do not come back on the next sync), add events that are not linked to Google Calendar, sync the calendar feeds into the database and push the calendar to the reMarkable with annotations preserved.

```bash
cd app
npm install
npm run dev        # server on :3210 + Vite client on http://localhost:5173
```

For a single-process setup build the client once and start the server, which then serves it on http://localhost:3210:

```bash
npm run build && npm start
```

Buttons in the header:

- **Sync calendar** fetches the next 30 days from the feeds in `config/config.yaml` into `output/calendar.db`.
- **Update reMarkable** regenerates the year PDF from the database, downloads the current device copy, merges your handwritten annotations and uploads.

The Activity page streams the log of every run and exposes the individual steps (full daily sync, whole-year fetch, PDF only, device backup only).

### Command line

The orchestration that used to live in the shell scripts is now `app/src/cli.ts`; the shell scripts under `scripts/` are thin wrappers around it, so existing Shortcuts automations keep working.

```bash
cd app
npm run cli -- sync [--skip-fetch] [--days 7]   # daily flow: fetch, backup, merge annotations, upload
npm run cli -- fetch [days]                     # refresh Google events for the next N days (default 30)
npm run cli -- fetch-year [year]                # refresh Google events for a whole year
npm run cli -- generate [year]                  # render the year PDF from the database
npm run cli -- upload                           # backup + merge annotations + upload, no fetch
npm run cli -- backup ["Calendar 2026"]         # download the device copy into backups/
npm run cli -- stats
npm test                                        # unit tests for the DB layer, ICS expansion and API
```

PDF rendering (`remarkable_calendar.py`) and the `.rmdoc` annotation merge remain in Python and are spawned by the Node code, so the `venv/` is still required. `remarkable_calendar/event_fetcher.py` is superseded by `app/src/server/ics.ts`.

## Commands

```bash
./remarkable_calendar.sh generate 7        # Get calendar events for next 7 days and update year calendar PDF
./remarkable_calendar.sh generate-full    # Generate calendar for entire year
./remarkable_calendar.sh upload           # Upload existing PDF to reMarkable
```

## Test Scripts

Test calendar designs without fetching real events:

```bash
# Daily calendar with sample events
python remarkable_calendar/test_design.py

# Daily calendar for specific date
python remarkable_calendar/test_design.py --date 2026-01-20

# Empty daily calendar
python remarkable_calendar/test_design.py --empty

# Year calendar
python remarkable_calendar/test_design.py --year
python remarkable_calendar/test_design.py --year 2026

# Custom output path
python remarkable_calendar/test_design.py --output output/my_test.pdf
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

- **Year calendar**: Edit `remarkable_calendar/year_calendar.py`
- **Daily pages**: Edit `remarkable_calendar/renderers.py`
- **Settings**: Edit `remarkable_calendar/settings.py`

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
   PROJECT="/Users/felipepavanela/Documents/Dev/reMarkableCalendar"
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

2. **Create new shortcut** named "reMarkableCalendar Daily Sync"
   - Add action: **Run Shell Script**
   - Paste this script:
     ```bash
     {root_path_to_project}/reMarkableCalendar/scripts/remarkable-sync-calendar.sh
     ```
   - Add action: **Show Notification** (optional)
     - Title: `reMarkableCalendar Sync Complete`
     - Body: `Calendar synced to reMarkable`

3. **Create automation**
   - Go to **Automation** tab in Shortcuts
   - Click **+** → **Personal Automation**
   - Select **Time of Day** → Choose your preferred time (e.g., 9:00 AM)
   - Set to repeat: **Daily**
   - Add action: **Run Shortcut** → Select "reMarkableCalendar Daily Sync"
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
     /Users/felipepavanela/Documents/Dev/reMarkableCalendar/scripts/remarkable-sync-calendar.sh
     ```
   - Save as `reMarkableCalendarSync.app` in `~/Applications/`

2. **Set up Calendar alarm**
   - Open **Calendar** app
   - Create new event: "reMarkableCalendar Sync"
   - Set to repeat: **Daily** at your preferred time
   - Add alert: **Custom** → **Open file** → Select `reMarkableCalendarSync.app`

### Manual Scripts

You can also run these scripts manually:

#### Main automation script

```bash
./scripts/remarkable-sync-calendar.sh
```

#### Core reMarkableCalendar commands

```bash
./scripts/remarkable_calendar.sh generate 7     # Generate next 7 days
./scripts/remarkable_calendar.sh upload         # Upload to reMarkable
./scripts/remarkable_calendar.sh generate-full  # Generate full year
```

#### Annotation preservation

```bash
# Preserve annotations when updating calendar (downloads from reMarkable)
./remarkable_calendar/remarkable_calendar_merge_annotations.py

# Regenerate PDF from database and merge with backup annotations
./remarkable_calendar/remarkable_calendar_merge_from_backup.py

# List available backup files
./remarkable_calendar/remarkable_calendar_merge_from_backup.py --list-backups

# Use specific backup file
./remarkable_calendar/remarkable_calendar_merge_from_backup.py --backup "backups/Calendar 2026_20260202_093512.rmdoc"

# Skip upload (just create merged .rmdoc)
./remarkable_calendar/remarkable_calendar_merge_from_backup.py --no-upload
```

#### Database management

```bash
# View database statistics
python3 remarkable_calendar/calendar_db_sqlite.py stats

# Export all events from database
python3 remarkable_calendar/calendar_db_sqlite.py export

# Database backups are automatically created in backups/db/
```

The `events` table has two extra columns managed by the web app: `source` (`google` or `manual`) and `deleted_at` (soft delete). Syncing only replaces non-deleted Google rows, so manual and removed events survive.

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
    - Check marker file: `ls -la logs/remarkable_calendar_run_$(date +%Y-%m-%d)`
    - Manually delete marker file to force run: `rm logs/remarkable_calendar_run_$(date +%Y-%m-%d)`
- **Script fails when run manually**:
    - Ensure you're in the project directory or use absolute paths
    - Check script permissions: `chmod +x scripts/*.sh`
- **Backup merge script fails**:
    - Make script executable: `chmod +x remarkable_calendar/remarkable_calendar_merge_from_backup.py`
    - Check backup directory: `ls -la backups/`
    - Ensure new calendar PDF exists: `ls -la output/calendar_*.pdf`

## License

MIT License
