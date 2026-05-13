#!/usr/bin/env bash
# Debug eval helper — sends JS to the running Claudette debug server.
# Usage: ${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh 'return 1 + 1'
#        echo 'return document.title' | ${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh
#
# Port selection:
#   1. $CLAUDETTE_DEBUG_PORT overrides everything (explicit win).
#   2. Otherwise, discover live `dev` instances via ${TMPDIR}/claudette-dev/*.json.
#      Prefer the instance whose `cwd` is an ancestor of $PWD (match worktree).
#      If exactly one instance is alive and no match, use it.
#      If multiple instances are alive and no match, print the list and exit.
#   3. Fall back to 19432 (legacy default).
set -euo pipefail

HOST="127.0.0.1"
TIMEOUT=12
DISCOVERY_DIR="${TMPDIR:-/tmp}/claudette-dev"

# --- Port discovery -------------------------------------------------------
discover_port() {
  if [[ -n "${CLAUDETTE_DEBUG_PORT:-}" ]]; then
    echo "${CLAUDETTE_DEBUG_PORT}"
    return
  fi

  [[ -d "$DISCOVERY_DIR" ]] || { echo 19432; return; }

  # Collect live instances (pid still running, file readable).
  local instances=()
  shopt -s nullglob
  for f in "$DISCOVERY_DIR"/*.json; do
    # Tolerate missing jq — parse with python3 which we already require below.
    # Pass the path via sys.argv rather than string-interpolating it into the
    # Python source, so filenames containing quotes/backslashes don't break
    # the parser (and can't be used for shell-injection).
    local line
    line=$(python3 -c '
import json, os, sys
path = sys.argv[1]
try:
    with open(path) as fh:
        d = json.load(fh)
    pid = d.get("pid")
    if pid is None: sys.exit(0)
    os.kill(pid, 0)  # check alive
    print("{}|{}|{}|{}".format(pid, d.get("debug_port",""), d.get("cwd",""), d.get("branch","")))
except (FileNotFoundError, json.JSONDecodeError, KeyError):
    sys.exit(0)
except ProcessLookupError:
    try: os.unlink(path)
    except OSError: pass
    sys.exit(0)
' "$f" 2>/dev/null) || continue
    [[ -n "$line" ]] && instances+=("$line")
  done
  shopt -u nullglob

  if [[ ${#instances[@]} -eq 0 ]]; then
    echo 19432
    return
  fi

  # Prefer an instance whose cwd is an ancestor of $PWD.
  local pwd_real
  pwd_real=$(cd "$PWD" && pwd -P)
  for inst in "${instances[@]}"; do
    IFS='|' read -r _pid port cwd _branch <<< "$inst"
    [[ -z "$cwd" ]] && continue
    if [[ "$pwd_real" == "$cwd" || "$pwd_real" == "$cwd"/* ]]; then
      echo "$port"
      return
    fi
  done

  if [[ ${#instances[@]} -eq 1 ]]; then
    IFS='|' read -r _pid port _cwd _branch <<< "${instances[0]}"
    echo "$port"
    return
  fi

  {
    echo "ERROR: Multiple Claudette dev instances are running and none match \$PWD ($pwd_real)."
    echo "Set CLAUDETTE_DEBUG_PORT=<port> to pick one, or run this from inside the target worktree."
    echo "Instances:"
    for inst in "${instances[@]}"; do
      IFS='|' read -r pid port cwd branch <<< "$inst"
      printf "  pid=%s  port=%s  branch=%s  cwd=%s\n" "$pid" "$port" "$branch" "$cwd"
    done
  } >&2
  exit 2
}

PORT=$(discover_port)

if [[ $# -gt 0 ]]; then
  JS="$*"
else
  JS="$(cat)"
fi

if [[ -z "${JS}" ]]; then
  echo "Usage: debug-eval.sh <javascript>" >&2
  exit 1
fi

python3 -c "
import socket, sys
s = socket.socket()
s.settimeout(${TIMEOUT})
try:
    s.connect(('${HOST}', ${PORT}))
except ConnectionRefusedError:
    print('ERROR: Cannot connect to debug server on ${HOST}:${PORT}', file=sys.stderr)
    print('The dev build must be running via the devshell \`dev\` helper (or \`cargo tauri dev\`).', file=sys.stderr)
    print('Do NOT launch the installed /Applications/Claudette.app — it has no debug server.', file=sys.stderr)
    print('Ask the user to start \`dev\` if it is not already running.', file=sys.stderr)
    sys.exit(1)
s.sendall(sys.stdin.buffer.read())
s.shutdown(socket.SHUT_WR)
data = b''
while True:
    try:
        chunk = s.recv(4096)
        if not chunk: break
        data += chunk
    except: break
s.close()
sys.stdout.buffer.write(data)
" <<< "${JS}"
