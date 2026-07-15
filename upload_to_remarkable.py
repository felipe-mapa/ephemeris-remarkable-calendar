#!/usr/bin/env python3
"""
Upload a file to reMarkable tablet.

Usage:
    python upload_to_remarkable.py <file_path> [--dest <remarkable_folder>]

Examples:
    python upload_to_remarkable.py ~/Documents/notes.pdf
    python upload_to_remarkable.py report.pdf --dest /My Folder
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def get_config_path():
    script_dir = Path(__file__).parent
    return script_dir / "config" / ".rmapi"


def find_docker() -> str:
    docker = shutil.which("docker")
    if docker:
        return docker
    for candidate in ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"]:
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError("docker not found — is Docker Desktop running?")


def upload_file(file_path: str, dest_folder: str = "/") -> bool:
    file_path = os.path.abspath(file_path)

    if not os.path.isfile(file_path):
        print(f"Error: file not found: {file_path}")
        return False

    config_path = get_config_path()
    if not config_path.exists():
        print(f"Error: reMarkable credentials not found at {config_path}")
        print("Run the setup first: python ephemeris/remarkable_credentials.py setup")
        return False

    try:
        docker = find_docker()
    except FileNotFoundError as e:
        print(f"Error: {e}")
        return False

    filename = os.path.basename(file_path)
    file_dir = os.path.dirname(file_path)
    container_file = f"/upload/{filename}"

    rmapi_args = ["put", "--force"]
    if dest_folder and dest_folder != "/":
        rmapi_args += ["--path", dest_folder.rstrip("/")]
    rmapi_args.append(container_file)

    cmd = [
        docker, "run", "--rm",
        "-v", f"{config_path}:/root/.config/rmapi",
        "-v", f"{file_dir}:/upload",
        "ephemeris-rmapi:latest",
        "rmapi",
    ] + rmapi_args

    print(f"Uploading '{filename}' to reMarkable (folder: {dest_folder or '/'})...")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        print("Error: upload timed out after 60 seconds")
        return False

    if result.stdout:
        print(result.stdout.strip())
    if result.stderr:
        print(result.stderr.strip())

    if result.returncode == 0:
        print(f"✅ '{filename}' uploaded successfully!")
        return True
    else:
        print(f"❌ Upload failed (exit {result.returncode})")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Upload a file to your reMarkable tablet"
    )
    parser.add_argument("file", help="Path to the file to upload")
    parser.add_argument(
        "--dest",
        default="/",
        metavar="FOLDER",
        help="Destination folder on reMarkable (default: root /)",
    )
    args = parser.parse_args()

    success = upload_file(args.file, args.dest)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
