#!/usr/bin/env python3
"""
Preserve reMarkable annotations when updating calendar PDF

Strategy:
1. Download the old calendar .rmdoc (contains PDF + .rm annotation files)
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


def get_script_dir():
    return os.path.dirname(os.path.abspath(__file__))


def get_config_path():
    return os.path.abspath(os.path.join(get_script_dir(), "..", "config", ".rmapi"))


def run_rmapi_command(output_dir, *args):
    """Run an rmapi command via Docker with timeout"""
    config_path = get_config_path()
    cmd = [
        'docker', 'run', '--rm',
        '-v', f"{config_path}:/root/.config/rmapi",
        '-v', f"{output_dir}:/app/output",
        '-w', '/app/output',
        'ephemeris-rmapi:latest',
        'rmapi'
    ] + list(args)
    
    print(f"Running: rmapi {' '.join(args)}")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.stdout:
            print(f"stdout: {result.stdout[:500]}")
        if result.stderr:
            print(f"stderr: {result.stderr[:500]}")
        return result
    except subprocess.TimeoutExpired:
        print(f"Command timed out after 60 seconds: rmapi {' '.join(args)}")
        print("💡 This may be due to network issues or reMarkable cloud service problems")
        # Return a fake result with timeout error
        class TimeoutResult:
            def __init__(self):
                self.returncode = 124
                self.stdout = ""
                self.stderr = "Command timed out after 60 seconds"
        return TimeoutResult()


def find_calendar_document(year, output_dir):
    """Find the calendar document on reMarkable"""
    print(f"Looking for Calendar {year} on reMarkable...")
    
    result = run_rmapi_command(output_dir, 'ls')
    
    # Check for timeout or error
    if result.returncode != 0:
        print(f"Failed to list documents: {result.stderr}")
        print("💡 Unable to connect to reMarkable cloud service")
        return None
    
    # Parse output to find the calendar
    # Format: [d] or [f] followed by document name
    calendar_docs = []
    for line in result.stdout.split('\n'):
        line = line.strip()
        if f"Calendar {year}" in line:
            # Found it - extract the path
            if line.startswith('[f]'):
                doc_name = line[3:].strip()
                calendar_docs.append(doc_name)
                print(f"Found document: {doc_name}")
    
    # If we found exactly one, return it
    if len(calendar_docs) == 1:
        return calendar_docs[0]
    elif len(calendar_docs) > 1:
        print(f"Found {len(calendar_docs)} calendar documents, using first one: {calendar_docs[0]}")
        return calendar_docs[0]
    else:
        print(f"Calendar {year} not found on reMarkable")
        print("Available documents:")
        for line in result.stdout.split('\n'):
            line = line.strip()
            if line and ('Calendar' in line.lower() or '2026' in line):
                print(f"  - {line}")
        return None


def backup_rmdoc(rmdoc_path, doc_name):
    """Create a backup of the original .rmdoc file with timestamp"""
    import time
    
    # Create backups directory if it doesn't exist
    script_dir = get_script_dir()
    backup_dir = os.path.join(script_dir, "..", "backups")
    os.makedirs(backup_dir, exist_ok=True)
    
    # Create timestamp
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    backup_filename = f"{doc_name}_{timestamp}.rmdoc"
    backup_path = os.path.join(backup_dir, backup_filename)
    
    # Copy the file to backup location
    try:
        shutil.copy2(rmdoc_path, backup_path)
        print(f"  📋 Created backup: {backup_filename}")
    except Exception as e:
        print(f"  ⚠️ Could not create backup: {e}")


def download_raw_document_with_annotations(doc_name, output_dir):
    """
    Download the raw document using 'get' command.
    If multiple documents with the same name exist, download each and find the one with annotations.
    Returns tuple of (rmdoc_path, has_annotations)
    """
    print(f"Downloading raw document '{doc_name}'...")
    
    # First, use 'find' to get all matching documents
    find_result = run_rmapi_command(output_dir, 'find', '.', doc_name)
    
    # Check for timeout or error
    if find_result.returncode != 0:
        print(f"Failed to find document: {find_result.stderr}")
        print("💡 Unable to search for documents on reMarkable")
        return None
    
    # Parse find results to get all matching paths (excluding trash)
    matching_paths = []
    for line in find_result.stdout.split('\n'):
        line = line.strip()
        if doc_name in line and '/trash/' not in line.lower():
            # Extract path - format is "[f] /path/to/doc"
            if line.startswith('[f]'):
                path = line[3:].strip()
                matching_paths.append(path)
    
    print(f"Found {len(matching_paths)} matching documents: {matching_paths}")
    
    if not matching_paths:
        # Fallback to simple get
        matching_paths = [doc_name]
    
    # Try each document and find one with annotations
    best_rmdoc = None
    best_has_annotations = False
    
    for i, doc_path in enumerate(matching_paths):
        # Create subdirectory for this download
        sub_dir = os.path.join(output_dir, f"doc_{i}")
        os.makedirs(sub_dir, exist_ok=True)
        
        print(f"Trying document: {doc_path}")
        result = run_rmapi_command(sub_dir, 'get', doc_path)
        
        if result.returncode != 0:
            print(f"  Failed to download: {result.stderr}")
            if "timed out" in result.stderr.lower():
                print("  ⚠️  Download timed out - skipping this document")
            continue
        
        # Find the downloaded file
        rmdoc_path = None
        for f in os.listdir(sub_dir):
            if f.endswith('.rmdoc') or f.endswith('.zip'):
                rmdoc_path = os.path.join(sub_dir, f)
                break
        
        if not rmdoc_path:
            print(f"  No .rmdoc file found")
            continue
        
        # Create backup of the original .rmdoc file
        backup_rmdoc(rmdoc_path, doc_name)
        
        # Check if this document has annotations
        has_annotations = False
        try:
            with zipfile.ZipFile(rmdoc_path, 'r') as zf:
                for name in zf.namelist():
                    if name.endswith('.rm'):
                        has_annotations = True
                        break
        except:
            pass
        
        print(f"  Downloaded: {rmdoc_path}, has_annotations={has_annotations}")
        
        # Prefer document with annotations
        if has_annotations:
            best_rmdoc = rmdoc_path
            best_has_annotations = True
            print(f"  ✓ Found document with annotations!")
            break
        elif best_rmdoc is None:
            best_rmdoc = rmdoc_path
            best_has_annotations = False
    
    if best_rmdoc:
        print(f"Selected document: {best_rmdoc} (has_annotations={best_has_annotations})")
        return best_rmdoc
    
    print("Could not find any downloadable document")
    return None


def extract_rmdoc_contents(rmdoc_path, extract_dir):
    """
    Extract all contents from the .rmdoc file.
    Returns tuple of (original_pdf_path, has_annotations, doc_uuid)
    """
    print(f"Extracting contents from {rmdoc_path}...")
    
    os.makedirs(extract_dir, exist_ok=True)
    
    try:
        with zipfile.ZipFile(rmdoc_path, 'r') as zf:
            # List contents
            names = zf.namelist()
            print(f"Archive contents: {names[:10]}...")
            
            # Extract everything
            zf.extractall(extract_dir)
            
            # Find PDF file, doc UUID, and check for .rm annotation files
            pdf_path = None
            has_annotations = False
            doc_uuid = None
            
            for name in names:
                if name.endswith('.pdf'):
                    pdf_path = os.path.join(extract_dir, name)
                    doc_uuid = os.path.basename(name).replace('.pdf', '')
                if name.endswith('.rm'):
                    has_annotations = True
            
            if pdf_path:
                print(f"Extracted original PDF: {pdf_path}")
                print(f"Document UUID: {doc_uuid}")
                print(f"Has annotations: {has_annotations}")
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
    
    print(f"Created new .rmdoc: {output_rmdoc_path}")
    return output_rmdoc_path


def upload_rmdoc(rmdoc_path, doc_name):
    """Upload the .rmdoc file to reMarkable, replacing the existing document."""
    print(f"Uploading .rmdoc to reMarkable...")
    
    config_path = get_config_path()
    rmdoc_filename = os.path.basename(rmdoc_path)
    
    # Upload using --force to replace existing document
    print(f"Uploading document: {rmdoc_filename}")
    cmd_put = [
        'docker', 'run', '--rm',
        '-v', f"{config_path}:/root/.config/rmapi",
        '-v', f"{rmdoc_path}:/app/{rmdoc_filename}",
        'ephemeris-rmapi:latest',
        'rmapi', 'put', '--force', f'/app/{rmdoc_filename}'
    ]
    result = subprocess.run(cmd_put, capture_output=True, text=True)
    
    if result.returncode == 0:
        print("✅ Upload successful!")
        return True
    else:
        print(f"❌ Upload failed: {result.stderr}")
        print("💡 Please check your reMarkable connection and try again.")
        return False


def upload_merged(pdf_path, year):
    """Upload the merged PDF to reMarkable"""
    print("Uploading merged PDF to reMarkable...")
    
    # Create temporary file with correct name
    temp_file = os.path.join(os.path.dirname(pdf_path), f"Calendar {year}.pdf")
    shutil.copy2(pdf_path, temp_file)
    
    # Upload using --force to replace
    subprocess.run([
        'docker', 'run', '--rm',
        '-v', f"{os.path.dirname(pdf_path)}:/app/output",
        '-v', f"{os.path.dirname(os.path.abspath(__file__))}/../config/.rmapi:/root/.config/rmapi",
        'ephemeris-rmapi:latest',
        'rmapi', 'put', '--force', f"/app/output/Calendar {year}.pdf"
    ], check=True)
    
    # Clean up
    os.remove(temp_file)


def main():
    """Main function"""
    year = datetime.now().year
    
    # Paths
    script_dir = get_script_dir()
    output_dir = os.path.abspath(os.path.join(script_dir, "..", "output"))
    new_pdf_path = os.path.join(output_dir, f"calendar_{year}.pdf")
    
    # Create separate temp dirs for raw and annotated downloads
    temp_dir_raw = tempfile.mkdtemp(prefix="ephemeris_raw_")
    temp_dir_ann = tempfile.mkdtemp(prefix="ephemeris_ann_")
    
    print(f"=== Ephemeris Annotation Merge ===")
    print(f"Year: {year}")
    print(f"New PDF: {new_pdf_path}")
    print()
    
    try:
        # Step 1: Find existing calendar on reMarkable
        doc_name = find_calendar_document(year, temp_dir_raw)
        
        if not doc_name:
            print("No existing calendar found on reMarkable.")
            print("📤 Uploading new calendar...")
            upload_merged(new_pdf_path, year)
            print("\n✅ Successfully uploaded new calendar!")
            return
        
        # Step 2: Download raw document (.rmdoc with original PDF and .rm files)
        # This function handles multiple documents with same name and finds the one with annotations
        rmdoc_path = download_raw_document_with_annotations(doc_name, temp_dir_raw)
        
        if not rmdoc_path:
            print("Could not download raw document.")
            print("❌ Cannot upload without preserving annotations.")
            print("💡 Please check your reMarkable connection and try again.")
            sys.exit(1)
        
        # Step 3: Extract contents from .rmdoc
        extract_dir = os.path.join(temp_dir_raw, "extracted")
        original_pdf, has_annotations, doc_uuid = extract_rmdoc_contents(rmdoc_path, extract_dir)
        
        if not original_pdf or not doc_uuid:
            print("Could not extract original PDF from .rmdoc.")
            print("❌ Cannot upload without preserving annotations.")
            print("💡 The existing document may be corrupted.")
            sys.exit(1)
        
        if not has_annotations:
            print("No annotations found in document.")
            print("📤 Uploading updated calendar...")
            upload_merged(new_pdf_path, year)
            print("\n✅ Successfully uploaded updated calendar!")
            return
        
        # Step 4: Rebuild .rmdoc with new PDF while preserving original .rm annotation files
        # This keeps annotations in their native format instead of rendering to pixels
        new_rmdoc_path = os.path.join(temp_dir_ann, f"Calendar {year}.rmdoc")
        rebuilt = rebuild_rmdoc_with_new_pdf(extract_dir, doc_uuid, new_pdf_path, new_rmdoc_path)
        
        if not rebuilt:
            print("Failed to rebuild .rmdoc with new PDF.")
            print("❌ Cannot upload without preserving annotations.")
            print("💡 The calendar structure may be incompatible.")
            sys.exit(1)
        
        # Step 5: Upload the rebuilt .rmdoc
        success = upload_rmdoc(new_rmdoc_path, doc_name)
        
        if success:
            print("\n✅ Successfully updated calendar with preserved annotations!")
        else:
            print("\n❌ Failed to upload calendar with preserved annotations.")
            print("💡 Your original calendar with annotations remains unchanged on the device.")
            sys.exit(1)
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        # Clean up temp directories
        shutil.rmtree(temp_dir_raw, ignore_errors=True)
        shutil.rmtree(temp_dir_ann, ignore_errors=True)


if __name__ == "__main__":
    main()
