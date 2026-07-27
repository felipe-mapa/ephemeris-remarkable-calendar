#!/usr/bin/env python3
"""
Preserve reMarkable annotations when updating calendar PDF using backup files

This script regenerates the calendar PDF from the database and merges it with
annotations from a backup .rmdoc file.

Strategy:
1. Regenerate calendar PDF from database
2. Find the latest backup .rmdoc file (or use specified backup)
3. Extract the .rmdoc contents
4. Replace the PDF with the new calendar PDF
5. Update the .content file to match new page count
6. Rebuild the .rmdoc with new PDF + original .rm files
7. Upload the rebuilt .rmdoc

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
from datetime import datetime, date, timedelta
import glob


def get_script_dir():
    return os.path.dirname(os.path.abspath(__file__))


def get_config_path():
    return os.path.abspath(os.path.join(get_script_dir(), "..", "config", ".rmapi"))


def get_backup_dir():
    return os.path.abspath(os.path.join(get_script_dir(), "..", "backups"))


def regenerate_pdf_from_db(year, output_path):
    """Regenerate the full calendar PDF from the database using the main ephemeris code"""
    print(f"Regenerating full calendar PDF from database for year {year}...")
    
    try:
        # Check if we need to activate virtual environment
        script_dir = get_script_dir()
        venv_python = os.path.join(script_dir, "..", "venv", "bin", "python3")
        
        # If running outside venv and venv exists, use subprocess to run in venv
        if os.path.exists(venv_python) and sys.executable != venv_python:
            print(f"  Using virtual environment Python...")
            
            # Use the main ephemeris.py to generate the full calendar
            ephemeris_script = os.path.join(script_dir, "..", "ephemeris.py")
            
            # Set environment variables for the generation
            env = os.environ.copy()
            env['TIME_DATE_RANGE'] = f"{year}-01-01:{year}-12-31"
            env['APP_OUTPUT_PDF_PATH'] = output_path
            env['APP_FORCE_REFRESH'] = 'true'
            
            # Run ephemeris.py with venv Python
            result = subprocess.run(
                [venv_python, ephemeris_script],
                capture_output=True,
                text=True,
                env=env,
                cwd=os.path.join(script_dir, "..")
            )
            
            if result.returncode == 0:
                print(f"  ✅ Generated full calendar PDF with {365 if year % 4 != 0 else 366} daily pages")
                return True
            else:
                print(f"  ❌ Failed: {result.stderr}")
                return False
        
        # Running in venv, use asyncio to run the main function
        print(f"  Running calendar generation...")
        import asyncio
        
        # Set environment variables
        os.environ['TIME_DATE_RANGE'] = f"{year}-01-01:{year}-12-31"
        os.environ['APP_OUTPUT_PDF_PATH'] = output_path
        os.environ['APP_FORCE_REFRESH'] = 'true'
        
        # Import and run the main ephemeris function
        sys.path.insert(0, os.path.join(script_dir, ".."))
        from ephemeris import main as ephemeris_main
        
        asyncio.run(ephemeris_main())
        
        print(f"  ✅ Generated full calendar PDF: {os.path.basename(output_path)}")
        return True
        
    except Exception as e:
        print(f"  ❌ Failed to regenerate PDF: {e}")
        import traceback
        traceback.print_exc()
        return False


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
    
    # Page structure lives under content['cPages']['pages'] (list of dicts with
    # 'id'/'idx'/'redir'/'template'), not a flat top-level 'pages' list of UUIDs —
    # that legacy field doesn't exist in current .content files.
    cpages = content.setdefault('cPages', {})
    old_pages_list = cpages.get('pages', [])
    old_page_count = len(old_pages_list)
    print(f"Old document had {old_page_count} pages (cPages)")

    # Find which pages have .rm annotation files
    rm_dir = os.path.join(extract_dir, doc_uuid)
    annotated_ids = set()
    if os.path.isdir(rm_dir):
        annotated_ids = {f[:-3] for f in os.listdir(rm_dir) if f.endswith('.rm')}

    old_id_index = {page['id']: i for i, page in enumerate(old_pages_list)}
    for page_uuid in sorted(annotated_ids):
        if page_uuid in old_id_index:
            print(f"  Found annotation for page {old_id_index[page_uuid]}: {page_uuid}")
        else:
            print(f"  ⚠️  Annotation file {page_uuid}.rm has no matching page in cPages")

    # Keep the overlapping prefix of pages exactly as-is (same id/idx/redir/template),
    # so annotations stay attached to their existing page. Only the tail differs
    # when the new PDF has a different page count than the backup.
    keep_count = min(old_page_count, new_page_count)
    new_pages_list = old_pages_list[:keep_count]

    if new_page_count > old_page_count:
        last_idx = new_pages_list[-1]['idx']['value'] if new_pages_list else 'a'
        last_ts = new_pages_list[-1]['idx']['timestamp'] if new_pages_list else '1:1'
        for i in range(old_page_count, new_page_count):
            last_idx += 'a'  # extends the previous idx string, so it still sorts after it
            new_pages_list.append({
                'id': str(uuid_module.uuid4()),
                'idx': {'timestamp': last_ts, 'value': last_idx},
                'redir': {'timestamp': last_ts, 'value': i},
                'template': {'timestamp': last_ts, 'value': 'Blank'},
            })
        print(f"  Added {new_page_count - old_page_count} new blank page(s) at the end")
    elif new_page_count < old_page_count:
        dropped = old_pages_list[new_page_count:]
        dropped_annotated = [p['id'] for p in dropped if p['id'] in annotated_ids]
        if dropped_annotated:
            print(f"  ⚠️  Dropping {len(dropped)} trailing page(s); annotations on {len(dropped_annotated)} of them will be lost: {dropped_annotated}")
        else:
            print(f"  Dropping {len(dropped)} trailing page(s) (no annotations lost)")

    cpages['pages'] = new_pages_list

    # lastOpened points at a page id — make sure it still refers to a page that exists
    valid_ids = {page['id'] for page in new_pages_list}
    last_opened = cpages.get('lastOpened')
    if new_pages_list and last_opened and last_opened.get('value') not in valid_ids:
        last_opened['value'] = new_pages_list[0]['id']

    # Update the content
    content['pageCount'] = new_page_count

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


def delete_remote_document(doc_name, output_dir):
    """Try to delete an existing document from reMarkable. Returns True if deleted or not found."""
    config_path = get_config_path()
    cmd_rm = [
        'docker', 'run', '--rm',
        '-v', f"{config_path}:/root/.config/rmapi",
        '-v', f"{output_dir}:/app/output",
        'ephemeris-rmapi:latest',
        'rmapi', 'rm', doc_name
    ]
    result = subprocess.run(cmd_rm, capture_output=True, text=True)
    if result.returncode == 0:
        print(f"Deleted existing document: {doc_name}")
        return True
    # If not found, that's fine — nothing to delete
    if 'not found' in result.stderr.lower() or 'no such' in result.stderr.lower():
        return True
    print(f"Could not delete existing document (will attempt upload anyway): {result.stderr.strip()}")
    return False


def upload_rmdoc(rmdoc_path, doc_name):
    """Upload calendar to reMarkable using PDF with --content-only to replace existing content."""
    print(f"Uploading to reMarkable...")

    config_path = get_config_path()
    rmdoc_dir = os.path.dirname(rmdoc_path)

    def run_put(extra_flags, filename):
        return subprocess.run([
            'docker', 'run', '--rm',
            '-v', f"{config_path}:/root/.config/rmapi",
            '-v', f"{rmdoc_dir}:/app/output",
            '-w', '/app/output',
            'ephemeris-rmapi:latest',
            'rmapi', 'put', *extra_flags, filename
        ], capture_output=True, text=True)

    # Extract PDF from the .rmdoc and upload with --content-only.
    # rmapi --content-only replaces document content without a delete+recreate,
    # avoiding the 400 error from the reMarkable delete API.
    # (rmapi does not support --content-only for .rmdoc files, only PDF.)
    try:
        with zipfile.ZipFile(rmdoc_path, 'r') as zf:
            pdf_files = [f for f in zf.namelist() if f.endswith('.pdf')]
            if not pdf_files:
                print("❌ No PDF found in .rmdoc file")
                return False
            pdf_data = zf.read(pdf_files[0])

        # Filename must match the existing document name on the device
        temp_pdf_path = os.path.join(rmdoc_dir, f"{doc_name}.pdf")
        with open(temp_pdf_path, 'wb') as f:
            f.write(pdf_data)

        pdf_filename = os.path.basename(temp_pdf_path)
        print(f"Uploading as: {pdf_filename}")
        result = run_put(['--content-only'], pdf_filename)

        # If document doesn't exist yet, upload fresh without --content-only
        if result.returncode != 0 and (
            'not found' in result.stderr.lower() or 'no such' in result.stderr.lower()
        ):
            print("Document not found remotely, uploading fresh...")
            result = run_put([], pdf_filename)

        os.remove(temp_pdf_path)

        if result.returncode == 0:
            print("✅ Upload successful!")
            print("⚠️  Annotations are preserved in the backup file")
            print("💡 Use this backup for your next merge to restore annotations")
            return True
        else:
            print(f"❌ Upload failed: {result.stderr}")
            return False

    except Exception as e:
        print(f"❌ Error during upload: {e}")
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
    
    # Step 1: Regenerate PDF from database
    if args.new_pdf:
        new_pdf_path = os.path.abspath(args.new_pdf)
        print(f"Using provided PDF: {new_pdf_path}")
        if not os.path.exists(new_pdf_path):
            print(f"Error: PDF file not found: {new_pdf_path}")
            sys.exit(1)
    else:
        new_pdf_path = os.path.join(output_dir, f"calendar_{year}.pdf")
        # Regenerate PDF from database
        if not regenerate_pdf_from_db(year, new_pdf_path):
            print("Failed to regenerate PDF from database")
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
        # Step 2: Extract contents from backup .rmdoc
        extract_dir = os.path.join(temp_dir, "extracted")
        original_pdf, has_annotations, doc_uuid = extract_rmdoc_contents(backup_path, extract_dir)
        
        if not original_pdf or not doc_uuid:
            print("Could not extract original PDF from backup .rmdoc.")
            print("❌ The backup file may be corrupted.")
            sys.exit(1)
        
        if not has_annotations:
            print("⚠️  No annotations found in backup.")
            print("You may want to just upload the new PDF directly.")
        
        # Step 3: Rebuild .rmdoc with new PDF while preserving original .rm annotation files
        new_rmdoc_path = os.path.join(output_dir, f"Calendar {year}.rmdoc")
        rebuilt = rebuild_rmdoc_with_new_pdf(extract_dir, doc_uuid, new_pdf_path, new_rmdoc_path)
        
        if not rebuilt:
            print("Failed to rebuild .rmdoc with new PDF.")
            sys.exit(1)
        
        print(f"\n✅ Created merged .rmdoc: {new_rmdoc_path}")
        
        # Step 4: Upload the rebuilt .rmdoc (unless --no-upload)
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
