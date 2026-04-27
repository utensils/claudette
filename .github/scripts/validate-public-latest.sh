#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <repo> <tag>" >&2
  exit 2
fi

REPO="$1"
TAG="$2"
WORK_DIR="${RUNNER_TEMP:-/tmp}/claudette-public-latest-${TAG}"
LATEST_URL="https://github.com/${REPO}/releases/download/${TAG}/latest.json"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

curl_with_retry() {
  local label="$1"
  shift

  local attempt=1
  local max_attempts=8
  local delay=5
  local status=0

  while true; do
    if curl -fsSL "$@"; then
      return 0
    fi

    status=$?
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "::error::failed to validate ${label} after ${attempt} attempts (curl ${status})" >&2
      return "$status"
    fi

    echo "::warning::failed to validate ${label} on attempt ${attempt} (curl ${status}); retrying in ${delay}s" >&2
    sleep "$delay"

    attempt=$((attempt + 1))
    if [ "$delay" -lt 30 ]; then
      delay=$((delay * 2))
      if [ "$delay" -gt 30 ]; then
        delay=30
      fi
    fi
  done
}

curl_with_retry "$LATEST_URL" "$LATEST_URL" -o "$WORK_DIR/latest.json"

python3 - "$WORK_DIR/latest.json" "$WORK_DIR/urls.txt" "$REPO" "$TAG" <<'PY'
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

manifest_path = Path(sys.argv[1])
urls_path = Path(sys.argv[2])
repo = sys.argv[3]
target_tag = sys.argv[4]
owner, name = repo.split("/", 1)
marker = f"/{owner}/{name}/releases/download/"

data = json.loads(manifest_path.read_text())
urls = []
bad_urls = []


def walk(value):
    if isinstance(value, dict):
        for v in value.values():
            walk(v)
        return
    if isinstance(value, list):
        for v in value:
            walk(v)
        return
    if not isinstance(value, str):
        return

    parsed = urlparse(value)
    if parsed.netloc != "github.com" or marker not in parsed.path:
        return
    _, rest = parsed.path.split(marker, 1)
    tag, _, asset = rest.partition("/")
    if not asset:
        return
    urls.append(value)
    if tag != target_tag or "staging" in tag or tag.startswith("untagged-"):
        bad_urls.append(value)


walk(data)
if bad_urls:
    print("::error::public latest.json contains invalid release URLs:", file=sys.stderr)
    for url in bad_urls:
        print(f"  {url}", file=sys.stderr)
    sys.exit(1)
if not urls:
    print("::error::public latest.json contains no GitHub release asset URLs", file=sys.stderr)
    sys.exit(1)

urls_path.write_text("\n".join(sorted(set(urls))) + "\n")
PY

while IFS= read -r url; do
  echo "validating $url"
  curl_with_retry "$url" -r 0-0 -o /dev/null "$url"
done < "$WORK_DIR/urls.txt"
