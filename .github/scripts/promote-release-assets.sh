#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <repo> <staging-tag> <target-tag>" >&2
  exit 2
fi

REPO="$1"
STAGING_TAG="$2"
TARGET_TAG="$3"
WORK_DIR="${RUNNER_TEMP:-/tmp}/claudette-release-promote-${TARGET_TAG}"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

gh release download "$STAGING_TAG" \
  --repo "$REPO" \
  --dir "$WORK_DIR" \
  --clobber

if [ ! -f "$WORK_DIR/latest.json" ]; then
  echo "::error::staging release ${STAGING_TAG} does not contain latest.json" >&2
  exit 1
fi

python3 - "$WORK_DIR/latest.json" "$WORK_DIR/referenced-assets.txt" "$REPO" "$STAGING_TAG" "$TARGET_TAG" <<'PY'
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

manifest_path = Path(sys.argv[1])
assets_path = Path(sys.argv[2])
repo = sys.argv[3]
staging_tag = sys.argv[4]
target_tag = sys.argv[5]

owner, name = repo.split("/", 1)
marker = f"/{owner}/{name}/releases/download/"

data = json.loads(manifest_path.read_text())
asset_names = set()


def rewrite(value):
    if isinstance(value, dict):
        return {k: rewrite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [rewrite(v) for v in value]
    if not isinstance(value, str):
        return value

    parsed = urlparse(value)
    if parsed.netloc != "github.com" or marker not in parsed.path:
        return value

    prefix, rest = parsed.path.split(marker, 1)
    tag, _, asset = rest.partition("/")
    if not asset:
        return value

    asset_names.add(asset)
    if tag == staging_tag or tag.startswith("untagged-") or "staging" in tag:
        path = f"{prefix}{marker}{target_tag}/{asset}"
        return parsed._replace(path=path).geturl()
    return value


rewritten = rewrite(data)

bad_urls = []


def collect_bad(value):
    if isinstance(value, dict):
        for v in value.values():
            collect_bad(v)
        return
    if isinstance(value, list):
        for v in value:
            collect_bad(v)
        return
    if not isinstance(value, str):
        return

    parsed = urlparse(value)
    if parsed.netloc != "github.com" or marker not in parsed.path:
        return
    _, rest = parsed.path.split(marker, 1)
    tag, _, _ = rest.partition("/")
    if tag != target_tag or "staging" in tag or tag.startswith("untagged-"):
        bad_urls.append(value)


collect_bad(rewritten)
if bad_urls:
    print("::error::latest.json contains non-target release URLs:", file=sys.stderr)
    for url in bad_urls:
        print(f"  {url}", file=sys.stderr)
    sys.exit(1)

manifest_path.write_text(json.dumps(rewritten, indent=2, sort_keys=False) + "\n")
assets_path.write_text("\n".join(sorted(asset_names)) + "\n")
PY

while IFS= read -r asset; do
  if [ -n "$asset" ] && [ ! -f "$WORK_DIR/$asset" ]; then
    echo "::error::latest.json references asset missing from staging release: $asset" >&2
    exit 1
  fi
done < "$WORK_DIR/referenced-assets.txt"

mapfile -t ASSETS < <(find "$WORK_DIR" -maxdepth 1 -type f ! -name latest.json ! -name referenced-assets.txt | sort)
if [ "${#ASSETS[@]}" -gt 0 ]; then
  gh release upload "$TARGET_TAG" "${ASSETS[@]}" \
    --repo "$REPO" \
    --clobber
fi

# Upload the manifest last so clients never observe a new manifest before
# its referenced assets exist on the public release.
gh release upload "$TARGET_TAG" "$WORK_DIR/latest.json" \
  --repo "$REPO" \
  --clobber
