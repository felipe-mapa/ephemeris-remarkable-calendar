#!/usr/bin/env python3
"""
Test script for generating calendar designs (daily or year calendar).
Can be run standalone or imported by other scripts.

Usage:
    # Daily calendar with sample events
    python scripts/test_design.py [--date YYYY-MM-DD] [--output path/to/output.pdf]
    
    # Year calendar
    python scripts/test_design.py --year [YYYY] [--output path/to/output.pdf]
    
Environment variables (same as main ephemeris.py):
    DOC_SIDEBAR_ENABLED, DOC_SIDEBAR_WIDTH, DOC_TODO_LINES, DOC_NOTES_LINES, etc.
"""

import os
import sys
from pathlib import Path
from datetime import datetime, date, time, timedelta
from argparse import ArgumentParser

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from reportlab.pdfgen import canvas

import ephemeris.settings as settings
from ephemeris.fonts import init_fonts
from ephemeris.layout import get_page_size
from ephemeris.renderers import render_schedule_pdf
from ephemeris.year_calendar import render_year_calendar
from ephemeris.logger import configure_logging


def create_sample_events(target_date: date, tz_local):
    """
    Create sample events for testing the calendar design.
    Returns (timed_events, all_day_events) tuples.
    """
    # Sample timed events
    timed_events = [
        # Morning event
        (
            datetime.combine(target_date, time(6, 0), tzinfo=tz_local),
            datetime.combine(target_date, time(7, 0), tzinfo=tz_local),
            "Morning run & coffee",
            {"calendar_color": "#4285F4", "uid": "sample-1"}
        ),
        # Mid-morning appointment
        (
            datetime.combine(target_date, time(10, 0), tzinfo=tz_local),
            datetime.combine(target_date, time(11, 30), tzinfo=tz_local),
            "Doctor's Appointment for Mother",
            {"calendar_color": "#EA4335", "uid": "sample-2", "location": "Medical Center"}
        ),
        # Afternoon meeting
        (
            datetime.combine(target_date, time(14, 0), tzinfo=tz_local),
            datetime.combine(target_date, time(16, 0), tzinfo=tz_local),
            "Sales meeting",
            {"calendar_color": "#FBBC04", "uid": "sample-3", "location": "Conference Room A"}
        ),
        # Evening event (long)
        (
            datetime.combine(target_date, time(18, 0), tzinfo=tz_local),
            datetime.combine(target_date, time(22, 0), tzinfo=tz_local),
            "Alex's Birthday Party",
            {"calendar_color": "#34A853", "uid": "sample-4", "location": "123 Main St"}
        ),
    ]
    
    # Sample all-day events
    sod = datetime.combine(target_date, time.min, tzinfo=tz_local)
    sod_next = sod + timedelta(days=1)
    
    all_day_events = [
        (sod, sod_next, "Project Deadline", {"calendar_color": "#9C27B0", "uid": "sample-ad-1", "all_day": True}),
        (sod, sod_next, "Team Building Day", {"calendar_color": "#00BCD4", "uid": "sample-ad-2", "all_day": True}),
    ]
    
    return timed_events, all_day_events


def generate_test_day(
    target_date: date = None,
    output_path: str = None,
    timed_events: list = None,
    all_day_events: list = None,
    open_after: bool = True,
):
    """
    Generate a single day calendar PDF for testing design.
    
    Args:
        target_date: Date to render (default: today)
        output_path: Output PDF path (default: output/test_design.pdf)
        timed_events: List of timed events (default: sample events)
        all_day_events: List of all-day events (default: sample events)
        open_after: Whether to open the PDF after generation
        
    Returns:
        Path to the generated PDF
    """
    configure_logging()
    init_fonts()
    
    tz_local = settings.TZ_LOCAL
    
    if target_date is None:
        target_date = date.today()
    
    if output_path is None:
        output_path = "output/test_design.pdf"
    
    # Create sample events if not provided
    if timed_events is None or all_day_events is None:
        sample_timed, sample_all_day = create_sample_events(target_date, tz_local)
        if timed_events is None:
            timed_events = sample_timed
        if all_day_events is None:
            all_day_events = sample_all_day
    
    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    
    # Create canvas
    c = canvas.Canvas(output_path, pagesize=get_page_size())
    c.setAuthor("Ephemeris Test")
    
    # Add cover bookmark (required by render_schedule_pdf for year link)
    c.bookmarkPage("cover")
    
    # Render the schedule
    render_schedule_pdf(
        timed_events,
        output_path,
        target_date,
        all_day_events=all_day_events,
        tz_local=tz_local,
        all_day_in_grid=settings.ALLDAY_IN_GRID,
        valid_dates=[target_date],
        canvas_obj=c,
        draw_text=True,
        draw_shapes=True,
    )
    
    c.save()
    print(f"✅ Generated test PDF: {output_path}")
    
    if open_after:
        import subprocess
        subprocess.run(["open", output_path], check=False)
    
    return output_path


def generate_test_year(
    year: int = None,
    output_path: str = None,
    date_list: list = None,
    open_after: bool = True,
):
    """
    Generate a year calendar PDF for testing design.
    
    Args:
        year: Year to render (default: current year)
        output_path: Output PDF path (default: output/test_year_calendar.pdf)
        date_list: List of dates to make clickable (default: empty)
        open_after: Whether to open the PDF after generation
        
    Returns:
        Path to the generated PDF
    """
    configure_logging()
    init_fonts()
    
    if year is None:
        year = date.today().year
    
    if output_path is None:
        output_path = f"output/test_year_calendar_{year}.pdf"
    
    if date_list is None:
        date_list = []
    
    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    
    # Get page size
    width, height = get_page_size()
    
    # Create canvas
    c = canvas.Canvas(output_path, pagesize=(width, height))
    c.setAuthor("Ephemeris Test")
    
    # Add cover bookmark
    c.bookmarkPage("cover")
    
    # Render year calendar
    render_year_calendar(c, year, date_list, width, height)
    
    c.save()
    print(f"✅ Generated year calendar PDF: {output_path}")
    
    if open_after:
        import subprocess
        subprocess.run(["open", output_path], check=False)
    
    return output_path


def main():
    parser = ArgumentParser(description="Generate test calendar designs (daily or year)")
    
    # Mode selection
    parser.add_argument(
        "--year", "-y",
        type=int,
        nargs="?",
        const=-1,  # Flag present but no value = use current year
        default=None,
        help="Generate year calendar (optionally specify year, default: current year)"
    )
    parser.add_argument(
        "--date", "-d",
        type=str,
        default=None,
        help="Date to render for daily calendar (YYYY-MM-DD format, default: today)"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        default=None,
        help="Output PDF path"
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Don't open the PDF after generation"
    )
    parser.add_argument(
        "--empty",
        action="store_true",
        help="Generate with no events (empty calendar)"
    )
    
    args = parser.parse_args()
    
    # Year calendar mode
    if args.year is not None:
        year = args.year if args.year != -1 else None
        output_path = args.output or (f"output/test_year_calendar_{year or date.today().year}.pdf")
        generate_test_year(
            year=year,
            output_path=output_path,
            open_after=not args.no_open,
        )
        return
    
    # Daily calendar mode (default)
    target_date = None
    if args.date:
        try:
            target_date = datetime.strptime(args.date, "%Y-%m-%d").date()
        except ValueError:
            print(f"Error: Invalid date format '{args.date}'. Use YYYY-MM-DD.")
            sys.exit(1)
    
    # Handle empty calendar option
    timed_events = [] if args.empty else None
    all_day_events = [] if args.empty else None
    
    output_path = args.output or "output/test_design.pdf"
    
    generate_test_day(
        target_date=target_date,
        output_path=output_path,
        timed_events=timed_events,
        all_day_events=all_day_events,
        open_after=not args.no_open,
    )


if __name__ == "__main__":
    main()
