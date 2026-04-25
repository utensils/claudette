#!/usr/bin/env bash
# macOS helper: open the current aws-win-spinup instance in Windows App
# (the renamed Microsoft Remote Desktop). Auto-discovers the instance
# from the state dir or AWS tags — no env vars required.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_aws-common.sh
source "$SCRIPT_DIR/_aws-common.sh"

if [ "$(uname)" != "Darwin" ]; then
  echo "aws-win-rdp is macOS-only (uses 'open' + 'pbcopy')." >&2
  exit 2
fi

# Instance resolution: env var wins, then `current` state file, then
# newest running tag.
INSTANCE_ID="${CLAUDETTE_WIN_INSTANCE_ID:-}"
if [ -z "$INSTANCE_ID" ] && [ -r "$STATE_DIR/current" ]; then
  INSTANCE_ID=$(cat "$STATE_DIR/current")
fi
if [ -z "$INSTANCE_ID" ]; then
  INSTANCE_ID=$(discover_instance)
fi
[ -n "$INSTANCE_ID" ] || { echo "no running claudette-spinup instance found" >&2; exit 1; }

PUBLIC_IP=$(instance_public_ip "$INSTANCE_ID")
[ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "None" ] \
  || { echo "instance $INSTANCE_ID has no public IP" >&2; exit 1; }

# Password lookup: env var, then sidecar.
PASS_FILE=$(state_file "$INSTANCE_ID" pass)
PASSWORD="${CLAUDETTE_WIN_ADMIN_PASSWORD:-}"
if [ -z "$PASSWORD" ] && [ -r "$PASS_FILE" ]; then
  PASSWORD=$(cat "$PASS_FILE")
fi
if [ -n "$PASSWORD" ]; then
  printf %s "$PASSWORD" | pbcopy
  echo "Administrator password copied to clipboard (⌘-V in the password field)."
else
  echo "(no cached password found — was this instance launched by aws-win-spinup?)"
  echo "  expected: $PASS_FILE"
fi

RDP_FILE=$(state_file "$INSTANCE_ID" rdp)
cat > "$RDP_FILE" <<EOF
full address:s:$PUBLIC_IP
username:s:Administrator
prompt for credentials:i:1
EOF
echo "opening $RDP_FILE -> $PUBLIC_IP"
open "$RDP_FILE"
