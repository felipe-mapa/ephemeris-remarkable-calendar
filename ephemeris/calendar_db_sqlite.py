#!/usr/bin/env python3
"""
Calendar event database management using SQLite
"""

import sqlite3
import json
import os
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from pathlib import Path

def get_db_path():
    """Get the absolute path to the database file"""
    try:
        import ephemeris.settings as settings
        return str(settings.CALENDAR_DB)
    except (ImportError, AttributeError):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(script_dir, "../output/calendar.db")

def init_db():
    """Initialize the database schema"""
    db_path = get_db_path()
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            summary TEXT,
            description TEXT,
            location TEXT,
            dtstart TEXT NOT NULL,
            dtend TEXT NOT NULL,
            color TEXT,
            calendar TEXT,
            all_day INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_date ON events(date)
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_dtstart ON events(dtstart)
    ''')
    
    # Remove duplicates before creating unique index
    cursor.execute('''
        DELETE FROM events WHERE id NOT IN (
            SELECT MIN(id) FROM events 
            GROUP BY date, summary, dtstart
        )
    ''')
    
    cursor.execute('''
        CREATE UNIQUE INDEX IF NOT EXISTS idx_event_unique ON events(date, summary, dtstart)
    ''')
    
    conn.commit()
    conn.close()

def add_events(events: Dict[str, List[Dict]]):
    """Add events for specific dates, ignoring duplicates"""
    init_db()
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    for date_str, date_events in events.items():
        for event in date_events:
            # Check if event already exists (based on title, date and time)
            cursor.execute('''
                SELECT id FROM events 
                WHERE date = ? AND summary = ? AND dtstart = ?
            ''', (
                date_str,
                event.get('summary', ''),
                event.get('dtstart', '')
            ))
            
            if cursor.fetchone() is None:
                # Event doesn't exist, insert it
                cursor.execute('''
                    INSERT INTO events (date, summary, description, location, dtstart, dtend, color, calendar, all_day)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    date_str,
                    event.get('summary', ''),
                    event.get('description', ''),
                    event.get('location', ''),
                    event.get('dtstart', ''),
                    event.get('dtend', ''),
                    event.get('color', 'black'),
                    event.get('calendar', 'Unknown'),
                    1 if event.get('all_day', False) else 0
                ))
    
    conn.commit()
    conn.close()

def get_events_for_date_range(start_date: str, end_date: str) -> Dict[str, List[Dict]]:
    """Get all events for a date range"""
    init_db()
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('''
        SELECT date, summary, description, location, dtstart, dtend, color, calendar, all_day
        FROM events
        WHERE date >= ? AND date <= ?
        ORDER BY date, dtstart
    ''', (start_date, end_date))
    
    events = {}
    for row in cursor.fetchall():
        date_str = row[0]
        event = {
            'summary': row[1],
            'description': row[2],
            'location': row[3],
            'dtstart': row[4],
            'dtend': row[5],
            'color': row[6],
            'calendar': row[7],
            'all_day': bool(row[8])
        }
        
        if date_str not in events:
            events[date_str] = []
        events[date_str].append(event)
    
    conn.close()
    return events

def get_all_events() -> Dict[str, List[Dict]]:
    """Get all events in the database"""
    init_db()
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('''
        SELECT date, summary, description, location, dtstart, dtend, color, calendar, all_day
        FROM events
        ORDER BY date, dtstart
    ''')
    
    events = {}
    for row in cursor.fetchall():
        date_str = row[0]
        event = {
            'summary': row[1],
            'description': row[2],
            'location': row[3],
            'dtstart': row[4],
            'dtend': row[5],
            'color': row[6],
            'calendar': row[7],
            'all_day': bool(row[8])
        }
        
        if date_str not in events:
            events[date_str] = []
        events[date_str].append(event)
    
    conn.close()
    return events

def clear_events_for_date_range(start_date: str, end_date: str):
    """Clear events for a specific date range"""
    init_db()
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('DELETE FROM events WHERE date >= ? AND date <= ?', (start_date, end_date))
    
    conn.commit()
    conn.close()

def clear_all_events():
    """Clear all events from the database"""
    init_db()
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('DELETE FROM events')
    
    conn.commit()
    conn.close()

def get_stats():
    """Get database statistics"""
    init_db()
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('SELECT COUNT(*) FROM events')
    total_events = cursor.fetchone()[0]
    
    cursor.execute('SELECT COUNT(DISTINCT date) FROM events')
    total_dates = cursor.fetchone()[0]
    
    cursor.execute('SELECT MIN(date), MAX(date) FROM events')
    date_range = cursor.fetchone()
    
    conn.close()
    
    return {
        'total_events': total_events,
        'total_dates': total_dates,
        'date_range': date_range
    }

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: calendar_db_sqlite.py <command> [args]")
        print("Commands: clear_range, clear_all, get_range, export, stats")
        sys.exit(1)
    
    cmd = sys.argv[1]
    if cmd == "clear_range" and len(sys.argv) >= 4:
        clear_events_for_date_range(sys.argv[2], sys.argv[3])
        print(f"Cleared events from {sys.argv[2]} to {sys.argv[3]}")
    elif cmd == "clear_all":
        clear_all_events()
        print("Cleared all events")
    elif cmd == "get_range" and len(sys.argv) >= 4:
        events = get_events_for_date_range(sys.argv[2], sys.argv[3])
        print(json.dumps(events, indent=2))
    elif cmd == "export":
        events = get_all_events()
        print(json.dumps(events, indent=2))
    elif cmd == "stats":
        stats = get_stats()
        print(f"Total events: {stats['total_events']}")
        print(f"Total dates: {stats['total_dates']}")
        print(f"Date range: {stats['date_range'][0]} to {stats['date_range'][1]}")
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
