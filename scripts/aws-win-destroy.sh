#!/usr/bin/env bash
# Terminate every instance tagged Project=claudette-spinup in the
# target region and scrub local state. Safe to run with none present.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_aws-common.sh
source "$SCRIPT_DIR/_aws-common.sh"

mapfile -t IDS < <(aws_ ec2 describe-instances \
  --filters "Name=tag:Project,Values=claudette-spinup" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text | tr '\t' '\n' | sed '/^$/d')
if [ "${#IDS[@]}" -eq 0 ]; then
  echo "no claudette-spinup instances to destroy in $AWS_WIN_REGION"
  # Scrub any stale state files anyway.
  rm -f "$STATE_DIR"/*.pass "$STATE_DIR"/*.rdp "$STATE_DIR/current" 2>/dev/null || true
  exit 0
fi
echo "terminating: ${IDS[*]}"
aws_ ec2 terminate-instances --instance-ids "${IDS[@]}" \
  --query 'TerminatingInstances[].[InstanceId,CurrentState.Name]' --output text
aws_ ec2 wait instance-terminated --instance-ids "${IDS[@]}"
# Wipe the per-instance state + the `current` pointer.
for ID in "${IDS[@]}"; do
  rm -f "$(state_file "$ID" pass)" "$(state_file "$ID" rdp)" 2>/dev/null || true
done
rm -f "$STATE_DIR/current" 2>/dev/null || true
echo "terminated."
echo "note: SG (claudette-spinup-sg) is left in place for reuse."
