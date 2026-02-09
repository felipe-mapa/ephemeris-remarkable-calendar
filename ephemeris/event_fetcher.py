#!/usr/bin/env python3
"""
Fetch calendar events from ICS sources and save to database
"""

import os
import sys
import yaml
import requests
from datetime import datetime, timedelta, date
from dateutil import rrule
from dateutil.tz import tzlocal, gettz
from icalendar import Calendar
import calendar_db_sqlite as calendar_db

TIMEZONE = gettz("Pacific/Auckland")
CONFIG_PATH = "../config/config.yaml"

def get_config_path():
    """Get the absolute path to the config file"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, CONFIG_PATH)

def load_config():
    """Load calendar configuration"""
    config_path = get_config_path()
    with open(config_path, 'r') as f:
        return yaml.safe_load(f)

def fetch_ics(source: str) -> Calendar:
    """Fetch and parse an ICS calendar from URL or file"""
    if source.startswith("http"):
        response = requests.get(source, timeout=30)
        response.raise_for_status()
        return Calendar.from_ical(response.content)
    else:
        with open(source, 'rb') as f:
            return Calendar.from_ical(f.read())

def normalize_datetime(dt, tz=TIMEZONE):
    """Convert date/datetime to timezone-aware datetime"""
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            return dt.replace(tzinfo=tz)
        return dt.astimezone(tz)
    elif isinstance(dt, date):
        return datetime.combine(dt, datetime.min.time()).replace(tzinfo=tz)
    return dt

def expand_recurring_event(component, start_date: date, end_date: date, tz=TIMEZONE):
    """Expand a recurring event into individual occurrences"""
    occurrences = []
    
    dtstart = component.decoded("dtstart")
    dtend = component.decoded("dtend") if component.get("dtend") else None
    
    # Calculate duration
    if dtend:
        if isinstance(dtstart, date) and not isinstance(dtstart, datetime):
            duration = dtend - dtstart
        else:
            duration = normalize_datetime(dtend, tz) - normalize_datetime(dtstart, tz)
    else:
        duration = timedelta(hours=1)
    
    rrule_str = component.get("rrule")
    if rrule_str:
        try:
            rule = rrule.rrulestr(rrule_str.to_ical().decode('utf-8'), dtstart=normalize_datetime(dtstart, tz))
            range_start = datetime.combine(start_date, datetime.min.time()).replace(tzinfo=tz)
            range_end = datetime.combine(end_date, datetime.max.time()).replace(tzinfo=tz)
            
            for occurrence in rule.between(range_start, range_end, inc=True):
                occurrences.append((occurrence, occurrence + duration))
        except Exception as e:
            print(f"Error expanding rrule: {e}", file=sys.stderr)
    else:
        # Single event
        norm_start = normalize_datetime(dtstart, tz)
        occurrences.append((norm_start, norm_start + duration))
    
    return occurrences

def extract_events_for_range(cal: Calendar, start_date: date, end_date: date, color: str, cal_name: str) -> dict:
    """Extract events from a calendar for a specific date range"""
    events_by_date = {}
    
    for component in cal.walk():
        if component.name != "VEVENT":
            continue
        
        summary = str(component.get("summary", ""))
        description = str(component.get("description", ""))
        location = str(component.get("location", ""))
        
        # Check if it's an all-day event
        dtstart_prop = component.get("dtstart")
        is_all_day = dtstart_prop and dtstart_prop.params.get("VALUE") == "DATE"
        
        # Get occurrences
        occurrences = expand_recurring_event(component, start_date, end_date, TIMEZONE)
        
        for occ_start, occ_end in occurrences:
            # Check if occurrence is in range
            occ_date = occ_start.date() if isinstance(occ_start, datetime) else occ_start
            if start_date <= occ_date <= end_date:
                date_str = occ_date.isoformat()
                
                event = {
                    "summary": summary,
                    "description": description,
                    "location": location,
                    "dtstart": occ_start.isoformat(),
                    "dtend": occ_end.isoformat(),
                    "color": color,
                    "calendar": cal_name,
                    "all_day": is_all_day
                }
                
                if date_str not in events_by_date:
                    events_by_date[date_str] = []
                events_by_date[date_str].append(event)
    
    return events_by_date

def fetch_events_only(start_date: date, end_date: date):
    """Fetch events from all calendars without saving to database"""
    config = load_config()
    all_events = {}
    
    for calendar_config in config.get("calendars", []):
        name = calendar_config.get("name", "Unknown")
        source = calendar_config.get("source")
        color = calendar_config.get("color", "black")
        
        if not source:
            print(f"Skipping {name}: no source configured", file=sys.stderr)
            continue
        
        print(f"Fetching {name} from {source[:50]}...", file=sys.stderr)
        
        try:
            cal = fetch_ics(source)
            events = extract_events_for_range(cal, start_date, end_date, color, name)
            
            # Merge events
            for date_str, date_events in events.items():
                if date_str not in all_events:
                    all_events[date_str] = []
                all_events[date_str].extend(date_events)
            
            event_count = sum(len(e) for e in events.values())
            print(f"  Found {event_count} events", file=sys.stderr)
            
        except Exception as e:
            print(f"  Error fetching {name}: {e}", file=sys.stderr)
            raise
    
    total = sum(len(e) for e in all_events.values())
    print(f"Fetched {total} events total", file=sys.stderr)
    
    return all_events

def save_events_to_db(events: dict):
    """Save events to database"""
    calendar_db.add_events(events)
    total = sum(len(e) for e in events.values())
    print(f"Saved {total} events to database", file=sys.stderr)

def fetch_and_save_events(start_date: date, end_date: date):
    """Fetch events from all calendars and save to database"""
    config = load_config()
    all_events = {}
    
    # Clear existing events for this date range first
    print(f"Clearing existing events from {start_date} to {end_date}...", file=sys.stderr)
    calendar_db.clear_date_range(start_date.isoformat(), end_date.isoformat())
    
    for calendar_config in config.get("calendars", []):
        name = calendar_config.get("name", "Unknown")
        source = calendar_config.get("source")
        color = calendar_config.get("color", "black")
        
        if not source:
            print(f"Skipping {name}: no source configured", file=sys.stderr)
            continue
        
        print(f"Fetching {name} from {source[:50]}...", file=sys.stderr)
        
        try:
            cal = fetch_ics(source)
            events = extract_events_for_range(cal, start_date, end_date, color, name)
            
            # Merge events
            for date_str, date_events in events.items():
                if date_str not in all_events:
                    all_events[date_str] = []
                all_events[date_str].extend(date_events)
            
            event_count = sum(len(e) for e in events.values())
            print(f"  Found {event_count} events", file=sys.stderr)
            
        except Exception as e:
            print(f"  Error fetching {name}: {e}", file=sys.stderr)
    
    # Save to database
    calendar_db.add_events(all_events)
    total = sum(len(e) for e in all_events.values())
    print(f"Saved {total} events to database", file=sys.stderr)
    
    return all_events

def main():
    if len(sys.argv) < 3:
        print("Usage: event_fetcher.py <start_date> <end_date>")
        print("  Dates in YYYY-MM-DD format")
        sys.exit(1)
    
    start_date = datetime.strptime(sys.argv[1], "%Y-%m-%d").date()
    end_date = datetime.strptime(sys.argv[2], "%Y-%m-%d").date()
    
    fetch_and_save_events(start_date, end_date)

if __name__ == "__main__":
    main()
