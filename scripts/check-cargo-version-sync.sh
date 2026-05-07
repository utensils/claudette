#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

cargo metadata --locked --format-version 1 --no-deps |
  python3 -c '
import json
import sys

metadata = json.load(sys.stdin)
workspace_members = set(metadata["workspace_members"])
packages = [
    package
    for package in metadata["packages"]
    if package["id"] in workspace_members
]

versions = {}
for package in packages:
    versions.setdefault(package["version"], []).append(
        (package["name"], package["manifest_path"])
    )

if len(versions) != 1:
    print("workspace package versions are not in sync", file=sys.stderr)
    for version, version_packages in sorted(versions.items()):
        print(f"  {version}:", file=sys.stderr)
        for name, manifest_path in sorted(version_packages):
            print(f"    - {name}: {manifest_path}", file=sys.stderr)
    sys.exit(1)

version, version_packages = next(iter(versions.items()))
print(
    f"Cargo workspace package versions are in sync: "
    f"{version} ({len(version_packages)} packages)"
)
'
