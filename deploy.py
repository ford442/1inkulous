#!/usr/bin/env python3
"""
Deploy 1inkulous production build to test.1ink.us/1inkulous.

Uploads ./dist as a single zip through the Contabo storage manager
(https://storage.noahcohn.com). The VPS extracts the archive and pushes files
over one persistent SFTP connection — SFTP credentials never leave the server.

Usage:
  1. npm run build
  2. export DEPLOY_TOKEN='...'   # from VPS / storage manager config
  3. python deploy.py

Optional env overrides:
  DEPLOY_TOKEN       Auth token (required unless set below)
  CONTABO_BASE_URL   default https://storage.noahcohn.com
  PROJECT_NAME       default 1inkulous
  BUILD_DIR          default dist
  DEPLOY_FOLDER      remote folder under test.1ink.us (default: PROJECT_NAME)

Requirements:
  pip install requests
"""

from __future__ import annotations

import io
import os
import sys
import zipfile
from pathlib import Path
from typing import Optional

import requests

# ============================================================
# PER-PROJECT CONFIGURATION
# ============================================================
PROJECT_NAME: str = os.environ.get("PROJECT_NAME", "1inkulous").strip() or "1inkulous"
BUILD_DIR: str = os.environ.get("BUILD_DIR", "dist").strip() or "dist"
CONTABO_BASE_URL: str = (
    os.environ.get("CONTABO_BASE_URL", "https://storage.noahcohn.com").strip()
    or "https://storage.noahcohn.com"
)
# Remote path -> test.1ink.us/1inkulous
DEPLOY_FOLDER: str = os.environ.get("DEPLOY_FOLDER", "1inkulous").strip() or "1inkulous"

# Prefer env; many sibling repos keep a shared token as fallback for local deploys.
DEPLOY_TOKEN: Optional[str] = os.environ.get("DEPLOY_TOKEN") or os.environ.get(
    "DEPLOY_TOKEN_FALLBACK"
)
# ============================================================



def fetch_remote_sizes(target_folder, target_site="test"):
    """Ask the VPS for {rel_path: bytes} already on the deploy target."""
    base = CONTABO_BASE_URL.rstrip("/")
    url = f"{base}/api/deploy/{PROJECT_NAME}/sizes"
    headers = {}
    token = globals().get("DEPLOY_TOKEN")
    if token:
        headers["X-Deploy-Token"] = token
    params = {"target_site": target_site or "test"}
    if target_folder:
        params["target_folder"] = target_folder
    try:
        response = requests.get(url, params=params, headers=headers, timeout=60)
        if response.status_code == 200:
            files = response.json().get("files") or {}
            print(f"Remote size map: {len(files)} file(s)")
            return {str(k).replace("\\", "/"): int(v) for k, v in files.items()}
        print(f"  ! sizes HTTP {response.status_code}; uploading all files")
    except Exception as exc:
        print(f"  ! Could not fetch remote sizes ({exc}); uploading all files")
    return {}


def build_zip(build_path: Path, skip_sizes=None) -> bytes:
    """Zip the contents of build_path into an in-memory archive."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file in sorted(build_path.rglob("*")):
            if file.is_dir():
                continue
            rel = file.relative_to(build_path)
            parts = rel.parts
            if any(p in (".git", "node_modules", "__pycache__") for p in parts):
                continue
            rel_s = str(rel).replace("\\", "/")
            local_size = file.stat().st_size
            if (skip_sizes or {}).get(rel_s) == local_size:
                print(f"  = {rel} ({local_size} bytes, unchanged)")
                continue
            zf.write(file, rel_s)
            print(f"  + {rel}")
    return buf.getvalue()


def deploy_bundle(build_path: Path) -> bool:
    """Zip the build and upload it as a single bundle."""
    target_folder = DEPLOY_FOLDER or PROJECT_NAME
    url = f"{CONTABO_BASE_URL.rstrip('/')}/api/deploy/{PROJECT_NAME}/bundle"
    headers = {}
    if DEPLOY_TOKEN:
        headers["X-Deploy-Token"] = DEPLOY_TOKEN

    print("Building zip archive...")
    target_folder_for_sizes = globals().get("DEPLOY_FOLDER") or globals().get("TARGET_FOLDER") or PROJECT_NAME
    if "target_folder" in locals() and target_folder:
        target_folder_for_sizes = target_folder
    target_site_for_sizes = globals().get("DEPLOY_TARGET", "test")
    print("Checking remote file sizes...")
    skip_sizes = fetch_remote_sizes(target_folder_for_sizes, target_site_for_sizes)
    zip_bytes = build_zip(build_path, skip_sizes)
    print(f"Archive size: {len(zip_bytes) / 1024:.1f} KB\n")

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as _zf:
        if not _zf.namelist():
            print("All files identical in size on the target; nothing to upload.")
            return True

    print("Uploading bundle...")
    try:
        response = requests.post(
            url,
            files={"bundle": ("build.zip", zip_bytes, "application/zip")},
            data={"target_folder": target_folder},
            headers=headers,
            timeout=300,
        )
    except Exception as exc:
        print(f"  ✗ Upload exception: {exc}")
        return False

    if response.status_code == 200:
        data = response.json()
        print(f"  ✓ {data.get('uploaded', 0)} files uploaded")
        if data.get("failed"):
            print("  Failures:")
            for f in data["failed"]:
                print(f"    ✗ {f['path']}: {f['error']}")
        return not data.get("failed")

    print(f"  ✗ {response.status_code}: {response.text[:400]}")
    if response.status_code in (401, 403):
        print(
            "  Hint: check DEPLOY_TOKEN — it must match the value configured "
            "on the storage manager VPS."
        )
    return False


def main() -> None:
    if not DEPLOY_TOKEN:
        print("ERROR: DEPLOY_TOKEN environment variable is required.", file=sys.stderr)
        print("  export DEPLOY_TOKEN='your_token_from_vps_env'", file=sys.stderr)
        sys.exit(1)

    site_url = f"https://test.1ink.us/{DEPLOY_FOLDER or PROJECT_NAME}/"
    print(f"\n=== Deploying '{PROJECT_NAME}' via Contabo -> {site_url} ===\n")

    build_path = Path(BUILD_DIR)
    if not build_path.exists() or not build_path.is_dir():
        print(f"ERROR: Build directory '{BUILD_DIR}/' does not exist.")
        print("Please run `npm run build` first.")
        sys.exit(1)

    index_html = build_path / "index.html"
    if not index_html.is_file():
        print(
            f"ERROR: {BUILD_DIR}/index.html is missing — run `npm run build` first.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        health = requests.get(
            f"{CONTABO_BASE_URL.rstrip('/')}/api/deploy/health", timeout=10
        )
        if health.status_code == 200:
            print(f"Contabo deploy service: {health.json().get('status', 'unknown')}")
    except Exception:
        print("Warning: Could not contact storage.noahcohn.com (continuing anyway).")

    print()
    success = deploy_bundle(build_path)

    print(
        f"\n=== {'Deployment complete' if success else 'Deployment finished with errors'} ==="
    )
    if success:
        print(f"Live at: {site_url}")
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
