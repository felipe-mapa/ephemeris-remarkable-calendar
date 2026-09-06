#!/usr/bin/env python3
"""
reMarkable credential management and setup utilities
"""

import os
import sys
import subprocess
import shutil
from pathlib import Path


def get_config_dir():
    """Get the reMarkable config directory path"""
    script_dir = Path(__file__).parent
    return script_dir.parent / "config" / ".rmapi"


def check_credentials():
    """Check if reMarkable credentials are properly configured"""
    config_dir = get_config_dir()
    
    if not config_dir.exists():
        return False, f"reMarkable credentials not found at {config_dir}"
    
    # Check for rmapi.conf format (newer format)
    rmapi_conf = config_dir / "rmapi.conf"
    if rmapi_conf.exists():
        try:
            with open(rmapi_conf, 'r') as f:
                content = f.read()
                if 'devicetoken:' in content and 'usertoken:' in content:
                    return True, "reMarkable credentials found in rmapi.conf"
        except Exception:
            pass
    
    # Check for separate files format (older format)
    required_files = ["devicetoken", "user", "pass"]
    missing_files = []
    
    for file_name in required_files:
        file_path = config_dir / file_name
        if not file_path.exists():
            missing_files.append(file_name)
    
    if missing_files:
        return False, f"Missing reMarkable credential files: {', '.join(missing_files)}"
    
    return True, "All reMarkable credentials found"


def setup_credentials():
    """Interactive setup for reMarkable credentials using Docker"""
    config_dir = get_config_dir()
    
    print("🔧 Setting up reMarkable credentials...")
    
    # Create config directory
    config_dir.mkdir(parents=True, exist_ok=True)
    print(f"✅ Created config directory: {config_dir}")
    
    # Check if Docker is available
    if not shutil.which("docker"):
        print("❌ Docker not found. Please install Docker first.")
        print("💡 Visit: https://docs.docker.com/get-docker/")
        return False
    
    # Check if Docker is running
    try:
        subprocess.run(["docker", "info"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("❌ Docker is not running. Please start Docker first.")
        return False
    
    print("🚀 Starting interactive reMarkable setup...")
    print("💡 Follow the prompts to configure your reMarkable device")
    print()
    
    # Run the interactive setup
    try:
        subprocess.run([
            "docker", "run", "--rm", "-it",
            "-v", f"{config_dir}:/root/.config/rmapi",
            "remarkable-calendar-rmapi:latest",
            "rmapi", "init"
        ], check=True)
        
        print()
        print("✅ reMarkable credentials configured successfully!")
        
        # Verify the credentials were created
        success, message = check_credentials()
        if success:
            print("✅ Credentials configured successfully!")
            return True
        else:
            print(f"⚠️  Setup completed but credential verification failed: {message}")
            return False
            
    except subprocess.CalledProcessError:
        print("❌ Interactive setup failed")
        print("💡 You can try manual setup as described in the README")
        return False


def main():
    """Main function for command line usage"""
    if len(sys.argv) != 2 or sys.argv[1] not in ["check", "setup"]:
        print("Usage: python remarkable_credentials.py <check|setup>")
        print("  check  - Check if reMarkable credentials are configured")
        print("  setup  - Interactive setup for reMarkable credentials")
        sys.exit(1)
    
    command = sys.argv[1]
    
    if command == "check":
        success, message = check_credentials()
        if success:
            print(f"✅ {message}")
            sys.exit(0)
        else:
            print(f"❌ {message}")
            sys.exit(1)
    
    elif command == "setup":
        if setup_credentials():
            sys.exit(0)
        else:
            sys.exit(1)


if __name__ == "__main__":
    main()
