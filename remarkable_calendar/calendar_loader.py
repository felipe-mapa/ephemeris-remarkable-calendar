from datetime import datetime, date, time
from tempfile import NamedTemporaryFile
import asyncio
import json

import aiohttp
import requests
import os
from icalendar import Calendar as iCal, Event as iCalEvent
from dateutil import tz as dateutil_tz
from loguru import logger

import remarkable_calendar.settings as settings


async def download_calendar_async(session: aiohttp.ClientSession, source: str) -> bytes:
    """
    Fetch an ICS calendar from a URL using aiohttp session.
    """
    async with session.get(source) as resp:
        resp.raise_for_status()
        return await resp.read()


def download_calendar(source: str) -> bytes:
    """
    Fetch an ICS calendar from a URL or file path (synchronous version).
    """
    if source.startswith("http"):
        resp = requests.get(source)
        resp.raise_for_status()
        return resp.content
    else:
        with open(source, "rb") as f:
            return f.read()


def parse_calendar(raw: bytes) -> iCal:
    """
    Parse raw ICS bytes into an icalendar.Calendar object.
    """
    return iCal.from_ical(raw)


def build_tz_factory(cal: iCal) -> dateutil_tz.tzical | None:
    """
    Extract VTIMEZONE blocks and build a tzical factory if present.
    """
    vtz_blocks = [comp for comp in cal.walk() if comp.name == "VTIMEZONE"]
    if not vtz_blocks:
        return None

    with NamedTemporaryFile(mode="wb", suffix=".ics", delete=False) as tf:
        for comp in vtz_blocks:
            for prop in list(comp.keys()):
                if prop.upper().startswith("X-"):
                    comp.pop(prop, None)
            tf.write(comp.to_ical())
        tf.flush()
        try:
            return dateutil_tz.tzical(tf.name)
        except ValueError as e:
            logger.warning("Invalid VTIMEZONE definition, ignoring: {}", e)
            return None


def extract_raw_events(cal: iCal, color: str, name: str) -> list[tuple]:
    """
    Walk VEVENTs, preserving timezone factory and metadata.
    Returns list of tuples: (component, color, tz_factory, name).
    """
    tz_factory = build_tz_factory(cal)
    events = []
    for comp in cal.walk():
        if comp.name != "VEVENT":
            continue
        events.append((comp, color, tz_factory, name))
    return events

def _dtstart_value(comp) -> datetime:
    """
    Convert a component's DTSTART to a timezone-aware datetime:
    - Date-only values become midnight local-time
    - Naive datetimes get local tzinfo attached
    """
    raw = comp.decoded("dtstart")
    # Date-only => combine to midnight
    if isinstance(raw, date) and not isinstance(raw, datetime):
        raw = datetime.combine(raw, time.min)
    # Attach local tzinfo if missing
    if raw.tzinfo is None:
        raw = raw.replace(tzinfo=settings.TZ_LOCAL)
    return raw

async def load_raw_events(sources: list[dict]) -> list[tuple]:
    """
    High-level loader: for each calendar entry, download, parse,
    and extract VEVENTs with VTIMEZONE support.
    Downloads HTTP sources in parallel for better performance.
    """
    all_events = []
    names = [entry.get("name", "<unknown>") for entry in sources]
    logger.debug("Loading {} calendars: {}", len(names), names)
    
    # Separate HTTP sources from directory/file sources
    http_sources = []
    local_sources = []
    
    for entry in sources:
        source = entry.get("source")
        if source and source.startswith("http"):
            http_sources.append(entry)
        else:
            local_sources.append(entry)
    
    # Process local sources synchronously (directories and files)
    for entry in local_sources:
        name = entry.get("name")
        color = entry.get("color", "black")
        source = entry.get("source")
        if os.path.isdir(source):
            logger.debug("Source {} is a directory; scanning for .ics files...", source)
            for filename in os.listdir(source):
                if not filename.lower().endswith(".ics"):
                    continue
                file_path = os.path.join(source, filename)
                logger.debug("  Found ICS file: {}", file_path)
                raw = download_calendar(file_path)
                cal = parse_calendar(raw)
                all_events.extend(extract_raw_events(cal, color, name))
            continue
        logger.debug("Fetching local calendar {} from {}...", name, source)
        raw = download_calendar(source)
        cal = parse_calendar(raw)
        all_events.extend(extract_raw_events(cal, color, name))
    
    # Process HTTP sources in parallel
    if http_sources:
        async with aiohttp.ClientSession() as session:
            tasks = []
            for entry in http_sources:
                name = entry.get("name")
                color = entry.get("color", "black")
                source = entry.get("source")
                logger.debug("Queuing HTTP calendar {} from {}...", name, source)
                task = _fetch_and_process_http_calendar(session, source, color, name)
                tasks.append(task)
            
            # Wait for all HTTP downloads to complete
            http_results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # Process results and handle any exceptions
            for i, result in enumerate(http_results):
                if isinstance(result, Exception):
                    logger.error("Failed to fetch calendar {}: {}", http_sources[i].get("name"), result)
                    continue
                all_events.extend(result)

    # Sort by dtstart, normalized to timezone-aware datetimes
    return sorted(
        all_events,
        key=lambda x: _dtstart_value(x[0])
    )


async def _fetch_and_process_http_calendar(session: aiohttp.ClientSession, source: str, color: str, name: str) -> list[tuple]:
    """
    Helper function to fetch and process a single HTTP calendar.
    """
    raw = await download_calendar_async(session, source)
    cal = parse_calendar(raw)
    return extract_raw_events(cal, color, name)


async def load_events_from_json() -> list[tuple]:
    """
    Load the events exported by the web app (app/src/server/pipeline.ts exportEventsJson)
    and convert them to the same format as load_raw_events (icalendar components).
    Returns list of tuples: (component, color, tz_factory, name).
    """
    path = settings.EVENTS_JSON
    if not path.exists():
        logger.warning("Events file not found at {}, rendering an empty calendar", path)
        return []

    logger.debug("Loading events from {}", path)
    rows = json.loads(path.read_text())
    all_events = []

    for row in rows:
        date_str = row.get('date', '')
        summary = row.get('summary') or ''
        dtstart_str = row.get('dtstart', '')
        dtend_str = row.get('dtend', '')
        all_day = bool(row.get('all_day'))

        event = iCalEvent()
        event.add('summary', summary)
        if row.get('description'):
            event.add('description', row['description'])
        if row.get('location'):
            event.add('location', row['location'])

        try:
            if all_day:
                dtstart = datetime.fromisoformat(dtstart_str).date()
                dtend = datetime.fromisoformat(dtend_str).date()
            else:
                dtstart = datetime.fromisoformat(dtstart_str)
                dtend = datetime.fromisoformat(dtend_str)
                if dtstart.tzinfo is None:
                    dtstart = dtstart.replace(tzinfo=settings.TZ_LOCAL)
                if dtend.tzinfo is None:
                    dtend = dtend.replace(tzinfo=settings.TZ_LOCAL)

            event.add('dtstart', dtstart)
            event.add('dtend', dtend)

            uid = f"{date_str}-{summary}-{dtstart_str}".replace(' ', '-').replace(':', '')
            event.add('uid', uid)
        except (ValueError, TypeError) as e:
            logger.warning("Failed to parse datetime for event '{}': {}", summary, e)
            continue

        # tz_factory is None because the datetimes are already timezone-aware
        all_events.append((event, row.get('color') or 'black', None, row.get('calendar') or 'Database'))

    logger.debug("Loaded {} events from JSON", len(all_events))
    return all_events
