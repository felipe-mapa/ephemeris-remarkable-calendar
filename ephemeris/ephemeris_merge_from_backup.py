#!/usr/bin/env python3
"""
Preserve reMarkable annotations when updating calendar PDF using backup files

This script is similar to ephemeris_merge_annotations.py but uses local backup
.rmdoc files instead of downloading from reMarkable cloud.

Strategy:
1. Find the latest backup .rmdoc file (or use specified backup)
2. Extract the .rmdoc contents
3. Replace the PDF with the new calendar PDF
4. Update the .content file to match new page count
5. Rebuild the .rmdoc with new PDF + original .rm files
6. Upload the rebuilt .rmdoc

This preserves handwritten notes in their original .rm format.
"""

import os
import sys
import subprocess
import tempfile
import shutil
import zipfile
import json
import uuid as uuid_module
from datetime import datetime
import glob


def get_script_dir():
    return os.path.dirname(os.path.abspath(__file__))


def get_config_path():
    return os.path.abspath(os.path.join(get_script_dir(), "..", "config", ".rmapi"))


def get_backup_dir():
    return os.path.abspath(os.path.join(get_script_dir(), "..", "backups"))


def find_latest_backup(doc_name=None, year=None):
    """
    Find the latest backup .rmdoc file.
    
    Args:
        doc_name: Optional document name to filter by (e.g., "Calendar 2026")
        year: Optional year to filter by
    
    Returns:
        Path to the latest backup file, or None if not found
    """
    backup_dir = get_backup_dir()
    
    if not os.path.exists(backup_dir):
        print(f"Backup directory not found: {backup_dir}")
        return None
    
    # Build pattern
    if doc_name:
        pattern = os.path.join(backup_dir, f"{doc_name}_*.rmdoc")
    elif year:
        pattern = os.path.join(backup_dir, f"Calendar {year}_*.rmdoc")
    else:
        pattern = os.path.join(backup_dir, "*.rmdoc")
    
    # Find all matching backup files
    backup_files = glob.glob(pattern)
    
    if not backup_files:
        print(f"No backup files found matching pattern: {pattern}")
        return None
    
    # Sort by modification time (oldest first)
    backup_files.sort(key=os.path.getmtime)
    
    print(f"Found {len(backup_files)} backup file(s)")
    for i, backup in enumerate(backup_files[:5]):  # Show first 5
        mtime = datetime.fromtimestamp(os.path.getmtime(backup))
        print(f"  {i+1}. {os.path.basename(backup)} ({mtime.strftime('%Y-%m-%d %H:%M:%S')})")
    
    return backup_files[0]


def list_backups(year=None):
    """List all available backup files"""
    backup_dir = get_backup_dir()
    
    if not os.path.exists(backup_dir):
        print(f"Backup directory not found: {backup_dir}")
        return []
    
    if year:
        pattern = os.path.join(backup_dir, f"Calendar {year}_*.rmdoc")
    else:
        pattern = os.path.join(backup_dir, "*.rmdoc")
    
    backup_files = glob.glob(pattern)
    backup_files.sort(key=os.path.getmtime)  # Oldest first
    
    return backup_files


def extract_rmdoc_contents(rmdoc_path, extract_dir):
    """
    Extract all contents from the .rmdoc file.
    Returns tuple of (original_pdf_path, has_annotations, doc_uuid)
    """
    print(f"Extracting contents from {os.path.basename(rmdoc_path)}...")
    
    os.makedirs(extract_dir, exist_ok=True)
    
    try:
        with zipfile.ZipFile(rmdoc_path, 'r') as zf:
            # List contents
            names = zf.namelist()
            print(f"Archive contents: {len(names)} files")
            
            # Extract everything
            zf.extractall(extract_dir)
            
            # Find PDF file, doc UUID, and check for .rm annotation files
            pdf_path = None
            has_annotations = False
            doc_uuid = None
            annotation_count = 0
            
            for name in names:
                if name.endswith('.pdf'):
                    pdf_path = os.path.join(extract_dir, name)
                    doc_uuid = os.path.basename(name).replace('.pdf', '')
                if name.endswith('.rm'):
                    has_annotations = True
                    annotation_count += 1
            
            if pdf_path:
                print(f"Extracted original PDF: {os.path.basename(pdf_path)}")
                print(f"Document UUID: {doc_uuid}")
                print(f"Has annotations: {has_annotations} ({annotation_count} .rm files)")
            else:
                print("No PDF found in archive")
            
            return pdf_path, has_annotations, doc_uuid
        
    except zipfile.BadZipFile:
        print(f"Error: {rmdoc_path} is not a valid zip archive")
        return None, False, None


def get_pdf_page_count(pdf_path):
    """Get page count from a PDF file without heavy dependencies."""
    import re
    with open(pdf_path, 'rb') as f:
        content = f.read()
    # Look for /Count N in the PDF
    matches = re.findall(rb'/Count\s+(\d+)', content)
    if matches:
        return max(int(m) for m in matches)
    return 0


def rebuild_rmdoc_with_new_pdf(extract_dir, doc_uuid, new_pdf_path, output_rmdoc_path):
    """
    Rebuild the .rmdoc with a new PDF while preserving .rm annotation files.
    
    This updates the .content file to match the new PDF's page count,
    and maps existing annotations to the same page numbers.
    """
    print(f"Rebuilding .rmdoc with new PDF...")
    
    # Read the new PDF to get page count
    new_page_count = get_pdf_page_count(new_pdf_path)
    print(f"New PDF has {new_page_count} pages")
    
    # Read the existing .content file
    content_path = os.path.join(extract_dir, f"{doc_uuid}.content")
    with open(content_path, 'r') as f:
        content = json.load(f)
    
    old_pages = content.get('pages', [])
    old_page_count = len(old_pages)
    print(f"Old document had {old_page_count} pages")
    
    # Find which pages have .rm annotation files
    rm_dir = os.path.join(extract_dir, doc_uuid)
    annotated_pages = {}  # page_uuid -> page_index
    if os.path.isdir(rm_dir):
        for f in os.listdir(rm_dir):
            if f.endswith('.rm'):
                page_uuid = f.replace('.rm', '')
                if page_uuid in old_pages:
                    annotated_pages[page_uuid] = old_pages.index(page_uuid)
                    print(f"  Found annotation for page {annotated_pages[page_uuid]}: {page_uuid}")
    
    # Build new pages array
    # Keep annotated pages at their original positions, generate new UUIDs for others
    new_pages = []
    for i in range(new_page_count):
        # Check if there's an annotation for this page index
        found_uuid = None
        for page_uuid, page_idx in annotated_pages.items():
            if page_idx == i:
                found_uuid = page_uuid
                break
        
        if found_uuid:
            new_pages.append(found_uuid)
        else:
            # Generate new UUID for pages without annotations
            new_pages.append(str(uuid_module.uuid4()))
    
    # Update the content
    content['pages'] = new_pages
    content['pageCount'] = new_page_count
    content['originalPageCount'] = new_page_count
    
    # Update redirectionPageMap if it exists
    if 'redirectionPageMap' in content:
        content['redirectionPageMap'] = list(range(new_page_count))
    
    # Write updated .content file
    with open(content_path, 'w') as f:
        json.dump(content, f, indent=4)
    print(f"Updated .content file with {new_page_count} pages")
    
    # Update .pagedata file (one line per page, usually "Blank")
    pagedata_path = os.path.join(extract_dir, f"{doc_uuid}.pagedata")
    if os.path.exists(pagedata_path):
        with open(pagedata_path, 'w') as f:
            for _ in range(new_page_count):
                f.write("Blank\n")
        print(f"Updated .pagedata file")
    
    # Replace the PDF
    old_pdf_path = os.path.join(extract_dir, f"{doc_uuid}.pdf")
    shutil.copy2(new_pdf_path, old_pdf_path)
    print(f"Replaced PDF with new calendar")
    
    # Create the new .rmdoc (zip file)
    with zipfile.ZipFile(output_rmdoc_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        # Add all files from extract_dir
        for root, dirs, files in os.walk(extract_dir):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, extract_dir)
                zf.write(file_path, arcname)
    
    print(f"Created new .rmdoc: {os.path.basename(output_rmdoc_path)}")
    return output_rmdoc_path


def upload_rmdoc(rmdoc_path, doc_name):
    """Upload the .rmdoc file to reMarkable, replacing the existing document."""
    print(f"Uploading .rmdoc to reMarkable...")
    
    config_path = get_config_path()
    
    # Create a temporary copy with the correct document name
    temp_rmdoc_path = rmdoc_path.replace('_merged.rmdoc', '.rmdoc')
    shutil.copy2(rmdoc_path, temp_rmdoc_path)
    
    rmdoc_filename = os.path.basename(temp_rmdoc_path)
    
    # Upload using --force to replace existing document
    print(f"Uploading document as: {rmdoc_filename}")
    cmd_put = [
        'docker', 'run', '--rm',
        '-v', f"{config_path}:/root/.config/rmapi",
        '-v', f"{temp_rmdoc_path}:/app/{rmdoc_filename}",
        'ghcr.io/rmitchellscott/ephemeris:main-rmapi0.0.32',
        'rmapi', 'put', '--force', f'/app/{rmdoc_filename}'
    ]
    result = subprocess.run(cmd_put, capture_output=True, text=True)
    
    # Clean up temporary file
    os.remove(temp_rmdoc_path)
    
    if result.returncode == 0:
        print("✅ Upload successful!")
        return True
    else:
        print(f"❌ Upload failed: {result.stderr}")
        print("💡 Please check your reMarkable connection and try again.")
        return False


def main():
    """Main function"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Merge new calendar PDF with annotations from backup .rmdoc file'
    )
    parser.add_argument(
        '--year',
        type=int,
        default=datetime.now().year,
        help='Calendar year (default: current year)'
    )
    parser.add_argument(
        '--backup',
        type=str,
        help='Path to specific backup .rmdoc file (default: use latest)'
    )
    parser.add_argument(
        '--list-backups',
        action='store_true',
        help='List available backup files and exit'
    )
    parser.add_argument(
        '--no-upload',
        action='store_true',
        help='Skip uploading to reMarkable (just create the merged .rmdoc)'
    )
    parser.add_argument(
        '--new-pdf',
        type=str,
        help='Path to new calendar PDF (default: output/calendar_YEAR.pdf)'
    )
    
    args = parser.parse_args()
    
    # List backups if requested
    if args.list_backups:
        print(f"=== Available Backups ===")
        backups = list_backups(args.year)
        if not backups:
            print("No backup files found")
        else:
            for i, backup in enumerate(backups):
                mtime = datetime.fromtimestamp(os.path.getmtime(backup))
                size_mb = os.path.getsize(backup) / (1024 * 1024)
                backup_name = os.path.basename(backup)
                print(f"{i+1}. {backup_name}")
                print(f"   Date: {mtime.strftime('%Y-%m-%d %H:%M:%S')}")
                print(f"   Size: {size_mb:.2f} MB")
                print(f"   Command: ./ephemeris/ephemeris_merge_from_backup.py --backup \"backups/{backup_name}\"")
                print()
        return
    
    year = args.year
    
    # Paths
    script_dir = get_script_dir()
    output_dir = os.path.abspath(os.path.join(script_dir, "..", "output"))
    
    if args.new_pdf:
        new_pdf_path = os.path.abspath(args.new_pdf)
    else:
        new_pdf_path = os.path.join(output_dir, f"calendar_{year}.pdf")
    
    if not os.path.exists(new_pdf_path):
        print(f"Error: New calendar PDF not found: {new_pdf_path}")
        print("Please generate the calendar first or specify --new-pdf")
        sys.exit(1)
    
    # Find backup file
    if args.backup:
        backup_path = os.path.abspath(args.backup)
        if not os.path.exists(backup_path):
            print(f"Error: Backup file not found: {backup_path}")
            sys.exit(1)
    else:
        backup_path = find_latest_backup(year=year)
        if not backup_path:
            print(f"Error: No backup files found for year {year}")
            print("Run with --list-backups to see available backups")
            sys.exit(1)
    
    print(f"=== Ephemeris Annotation Merge (from Backup) ===")
    print(f"Year: {year}")
    print(f"New PDF: {new_pdf_path}")
    print(f"Backup: {os.path.basename(backup_path)}")
    print()
    
    # Create temp directory
    temp_dir = tempfile.mkdtemp(prefix="ephemeris_backup_")
    
    try:
        # Step 1: Extract contents from backup .rmdoc
        extract_dir = os.path.join(temp_dir, "extracted")
        original_pdf, has_annotations, doc_uuid = extract_rmdoc_contents(backup_path, extract_dir)
        
        if not original_pdf or not doc_uuid:
            print("Could not extract original PDF from backup .rmdoc.")
            print("❌ The backup file may be corrupted.")
            sys.exit(1)
        
        if not has_annotations:
            print("⚠️  No annotations found in backup.")
            print("You may want to just upload the new PDF directly.")
        
        # Step 2: Rebuild .rmdoc with new PDF while preserving original .rm annotation files
        new_rmdoc_path = os.path.join(output_dir, f"Calendar {year}_merged.rmdoc")
        rebuilt = rebuild_rmdoc_with_new_pdf(extract_dir, doc_uuid, new_pdf_path, new_rmdoc_path)
        
        if not rebuilt:
            print("Failed to rebuild .rmdoc with new PDF.")
            sys.exit(1)
        
        print(f"\n✅ Created merged .rmdoc: {new_rmdoc_path}")
        
        # Step 3: Upload the rebuilt .rmdoc (unless --no-upload)
        if not args.no_upload:
            doc_name = f"Calendar {year}"
            success = upload_rmdoc(new_rmdoc_path, doc_name)
            
            if success:
                print("\n✅ Successfully updated calendar with preserved annotations!")
            else:
                print("\n❌ Failed to upload calendar.")
                print(f"💡 The merged .rmdoc is saved at: {new_rmdoc_path}")
                print("You can upload it manually or retry later.")
                sys.exit(1)
        else:
            print(f"\n✅ Merged .rmdoc created (upload skipped)")
            print(f"File: {new_rmdoc_path}")
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        # Clean up temp directory
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
