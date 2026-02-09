#!/usr/bin/env python3
"""
Display events directly from calendar ICS sources
Usage: python show_events.py [start_date] [end_date]
If no dates provided, defaults to today
"""

import sys
import os
from datetime import datetime, date, timedelta
from typing import Dict, List

# Add ephemeris to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'ephemeris'))
from event_fetcher import fetch_events_only, load_config

def parse_date(date_str: str) -> date:
    """Parse date string in various formats"""
    formats = ['%Y-%m-%d', '%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y']
    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unable to parse date: {date_str}")

def format_event(event: dict) -> str:
    """Format event for display"""
    dt_start = datetime.fromisoformat(event['dtstart'])
    time_str = dt_start.strftime('%I:%M%p').lower() if not event.get('all_day') else 'All day'
    
    # Clean up summary
    summary = event['summary'][:60] + '...' if len(event['summary']) > 60 else event['summary']
    
    color = event.get('color', 'black')
    calendar_name = event.get('calendar', 'Unknown')
    
    return f"  {time_str} - {summary} ({color}, {calendar_name})"

def main():
    # Parse arguments
    if len(sys.argv) == 1:
        # No dates provided, use today
        start_date = date.today()
        end_date = date.today()
        print(f"Events for today: {start_date.isoformat()}")
    elif len(sys.argv) == 2:
        # Single date provided
        start_date = parse_date(sys.argv[1])
        end_date = start_date
        print(f"Events for: {start_date.isoformat()}")
    elif len(sys.argv) == 3:
        # Date range provided
        start_date = parse_date(sys.argv[1])
        end_date = parse_date(sys.argv[2])
        print(f"Events from {start_date.isoformat()} to {end_date.isoformat()}")
    else:
        print("Usage: python show_events.py [start_date] [end_date]")
        print("  Dates in YYYY-MM-DD format")
        print("  Examples:")
        print("    python show_events.py                    # Today")
        print("    python show_events.py 2026-02-10         # Single date")
        print("    python show_events.py 2026-02-10 2026-02-15  # Date range")
        sys.exit(1)

    try:
        # Fetch events directly from calendar sources
        print("📡 Fetching events from calendar sources...")
        events = fetch_events_only(start_date, end_date)
        
        if not events:
            print("No events found in calendar sources for the specified date range.")
            return
        
        # Display events by date
        current_date = start_date
        total_events = 0
        
        while current_date <= end_date:
            date_str = current_date.isoformat()
            day_events = events.get(date_str, [])
            
            print(f"\n📅 {date_str} ({len(day_events)} events)")
            print("-" * 60)
            
            if day_events:
                for i, event in enumerate(day_events, 1):
                    print(f"{i:2d}. {format_event(event)}")
                    total_events += 1
            else:
                print("  No events")
            
            current_date += timedelta(days=1)
        
        print(f"\n📊 Total: {total_events} events across {len(events)} dates")
        
        # Show calendar sources
        config = load_config()
        calendars = config.get('calendars', [])
        if calendars:
            print(f"\n📆 Calendar sources: {len(calendars)}")
            for cal in calendars:
                name = cal.get('name', 'Unknown')
                source = cal.get('source', '')
                print(f"  • {name}: {source[:50]}...")
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
