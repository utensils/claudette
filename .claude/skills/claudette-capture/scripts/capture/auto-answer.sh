#!/usr/bin/env bash
# auto-answer — polls for agent questions and auto-picks option 1 (typically
# the "Recommended" option). Runs in background so the demo doesn't stall on
# AskUserQuestion tool calls. Logs to $TMP_DIR/auto-answer.log.
#
# Usage: auto-answer.sh <wsId> &

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../lib/common.sh"

WS_ID="${1:-$(cat "$TMP_DIR/lf-workspace-id" 2>/dev/null)}"
LOG="$TMP_DIR/auto-answer.log"
: > "$LOG"

log_file() { printf "[%s] %s\n" "$(date +%H:%M:%S)" "$*" >> "$LOG"; }

log_file "starting auto-answer loop for $WS_ID"

while true; do
  result=$(eval_js "
    const s = window.__CLAUDETTE_STORE__.getState();
    const ws = s.workspaces.find(w => w.id === '$WS_ID');
    const q = s.agentQuestions['$WS_ID'];
    return {
      agentStatus: ws?.agent_status,
      hasQuestion: !!q,
      toolUseId: q ? q.toolUseId : null,
      questions: q ? q.questions : [],
      hasPlan: !!s.planApprovals['$WS_ID'],
    };
  " 2>/dev/null || echo '{"agentStatus":"Error","hasQuestion":false}')

  status=$(echo "$result" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["agentStatus"])' 2>/dev/null || echo "Error")
  hasQ=$(echo "$result" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["hasQuestion"])' 2>/dev/null || echo "False")

  if [[ "$status" == "Idle" || "$status" == "Stopped" ]]; then
    log_file "agent idle, exiting"
    break
  fi

  if [[ "$hasQ" == "True" ]]; then
    log_file "question detected"
    # Build answers dict: question text -> first option label
    answers_json=$(echo "$result" | python3 -c '
import json, sys
d = json.load(sys.stdin)
out = {}
for q in d["questions"]:
    out[q["question"]] = q["options"][0]["label"]
print(json.dumps(out))
')
    tool_use_id=$(echo "$result" | python3 -c 'import json,sys;print(json.load(sys.stdin)["toolUseId"])')
    log_file "answering with: $answers_json"

    eval_js "
      await window.__CLAUDETTE_INVOKE__('submit_agent_answer', {
        workspaceId: '$WS_ID',
        toolUseId: '$tool_use_id',
        answers: $answers_json,
        annotations: null,
      });
      window.__CLAUDETTE_STORE__.getState().clearAgentQuestion('$WS_ID');
      return 'answered';
    " >> "$LOG" 2>&1 || log_file "answer eval failed"
  fi

  sleep 4
done
