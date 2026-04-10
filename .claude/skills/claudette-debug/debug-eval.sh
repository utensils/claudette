#!/usr/bin/env bash
# Debug eval helper — sends JS to the running Claudette debug server.
# Usage: .claude/skills/claudette-debug/debug-eval.sh 'return 1 + 1'
#        echo 'return document.title' | .claude/skills/claudette-debug/debug-eval.sh
set -euo pipefail

PORT="${CLAUDETTE_DEBUG_PORT:-19432}"
HOST="127.0.0.1"
TIMEOUT=12

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
    print('Is the app running via cargo tauri dev?', file=sys.stderr)
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
