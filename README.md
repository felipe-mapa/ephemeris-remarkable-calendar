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

2. **Initialize**

    ```bash
    cd scripts
    ./ephemeris.sh init
    ```

3. **Configure calendars** (optional)
    - Edit `config/config.yaml` to add your calendar sources

## Commands

```bash
./ephemeris.sh init 2029        # Setup  for specific year (default to current year)
./ephemeris.sh refresh 7        # Get calendar events for next 7 days and update year calendar PDF
./ephemeris.sh upload           # Upload existing PDF to reMarkable
```

## Test Scripts

```bash
# Year calendar only
./generate_year_calendar.sh   # Current year
./generate_year_calendar.sh 2025  # Specific year
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

## Troubleshooting

-   **Fonts not loading**: Check `fonts/` directory
-   **Upload fails**: Install and configure `rmapi`
-   **No events**: Verify calendar URLs in config

## License

MIT License
