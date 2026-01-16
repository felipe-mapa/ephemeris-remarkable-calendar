#!/usr/bin/env python3
"""
Year calendar cover page renderer with clickable days
"""

import calendar
from datetime import date, datetime
from reportlab.pdfgen import canvas
from reportlab.lib.colors import black, white, HexColor
from loguru import logger

import ephemeris.settings as settings
from ephemeris.utils import css_color_to_hex


def render_year_calendar(
    c: canvas.Canvas,
    year: int,
    date_list: list,
    page_w_pt: float,
    page_h_pt: float,
):
    """
    Render a full year calendar on a single page with clickable days.
    Each day links to its corresponding page in the PDF.
    
    Args:
        c: ReportLab canvas
        year: Year to render
        date_list: List of dates that have pages in the PDF
        page_w_pt: Page width in points
        page_h_pt: Page height in points
    """
    
    # Page margins
    margin_left = 30
    margin_right = 30
    margin_top = 60
    margin_bottom = 30

    # Font
    font_size = 44
    
    # Available space
    available_width = page_w_pt - margin_left - margin_right
    available_height = page_h_pt - margin_top - margin_bottom
    
    # Title with subtle underline
    c.setFont("Montserrat-Bold", font_size)
    c.setFillColor(black)
    title_y = page_h_pt - margin_top
    c.drawCentredString(page_w_pt / 2, title_y, str(year))
    
    # Add subtle underline
    title_width = c.stringWidth(str(year), "Montserrat-Bold", font_size)
    c.setStrokeColor(css_color_to_hex("black"))
    c.setLineWidth(0.5)
    underline_y = title_y - 8
    c.line((page_w_pt - title_width) / 2, underline_y, (page_w_pt + title_width) / 2, underline_y)
    
    # Calendar grid: 4 columns x 3 rows for 12 months
    cols = 4
    rows = 3
    
    # Spacing between month grids
    month_gap_h = 12
    month_gap_v = 12
    
    # Calculate month grid size
    month_width = (available_width - (cols - 1) * month_gap_h) / cols
    month_height = (available_height - 60 - (rows - 1) * month_gap_v) / rows  # 60 for title space
    
    # Create a mapping of dates to page numbers
    date_to_page = {}
    cover_offset = 1  # Account for this cover page
    for idx, d in enumerate(date_list):
        date_to_page[d] = idx + 1 + cover_offset  # +1 because pages are 1-indexed, +cover_offset for cover
    
    # Render each month
    month_names = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ]
    
    for month_num in range(1, 13):
        # Calculate position
        col = (month_num - 1) % cols
        row = (month_num - 1) // cols
        
        x_start = margin_left + col * (month_width + month_gap_h)
        y_start = page_h_pt - margin_top - 40 - row * (month_height + month_gap_v)
        
        render_month_grid(
            c,
            year,
            month_num,
            month_names[month_num - 1],
            x_start,
            y_start,
            month_width,
            month_height,
            date_to_page
        )


def render_month_grid(
    c: canvas.Canvas,
    year: int,
    month: int,
    month_name: str,
    x: float,
    y: float,
    width: float,
    height: float,
    date_to_page: dict
):
    """
    Render a single month calendar grid with clickable days.
    
    Args:
        c: ReportLab canvas
        year: Year
        month: Month number (1-12)
        month_name: Name of the month
        x, y: Top-left corner position
        width, height: Size of the month grid
        date_to_page: Dictionary mapping date objects to page numbers
    """
    
    # Month title
    title_height = 15
    c.setFont("Montserrat-Medium", 8)
    c.setFillColor(black)
    c.drawCentredString(x + width / 2, y - 10, month_name)
    
    # Day headers (S M T W T F S)
    day_headers = ["S", "M", "T", "W", "T", "F", "S"]
    header_height = 12
    header_y = y - title_height - 5
    
    # Calculate cell dimensions
    cell_width = width / 7
    grid_height = height - title_height - header_height - 10
    
    # Get calendar for this month
    cal = calendar.monthcalendar(year, month)
    num_weeks = len(cal)
    cell_height = grid_height / num_weeks
    
    # Draw day headers
    c.setFont("Montserrat-Regular", 6)
    c.setFillColor(css_color_to_hex("gray(50%)"))
    for i, day_header in enumerate(day_headers):
        header_x = x + i * cell_width + cell_width / 2
        c.drawCentredString(header_x, header_y, day_header)
    
    # Draw calendar days
    c.setFont("Montserrat-Regular", 7)
    
    for week_idx, week in enumerate(cal):
        for day_idx, day in enumerate(week):
            if day == 0:  # Empty cell
                continue
            
            # Calculate cell position
            cell_x = x + day_idx * cell_width
            cell_y = header_y - header_height - (week_idx + 1) * cell_height
            
            # Create date object
            current_date = date(year, month, day)
            
            # Check if this date has a page
            has_page = current_date in date_to_page
            
            # Draw day number
            text_x = cell_x + cell_width / 2
            text_y = cell_y + cell_height / 2 - 2
            
            if has_page:
                c.setFillColor(black)
            else:
                c.setFillColor(css_color_to_hex("gray(60%)"))
            
            c.drawCentredString(text_x, text_y, str(day))
            
            # Add clickable link if page exists
            if has_page:
                page_num = date_to_page[current_date]
                # Create internal link to the page bookmark
                c.linkRect(
                    "",  # No URL content
                    f"page{page_num}",  # Destination bookmark name
                    (cell_x, cell_y, cell_x + cell_width, cell_y + cell_height),
                    relative=0
                )

def add_page_destinations(c: canvas.Canvas, date_list: list):
    """
    Add named destinations for each page so the year calendar can link to them.
    Call this at the start of each daily page rendering.
    
    Args:
        c: ReportLab canvas
        date_list: List of dates
    """
    # This will be called from the main rendering loop
    # The destination is added when showPage() is called
    pass
