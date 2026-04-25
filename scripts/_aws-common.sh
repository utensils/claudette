#!/usr/bin/env bash
# Shared helpers for aws-win-* scripts. Source, don't exec.
#
# - State lives under $PRJ_ROOT/.claudette/aws-win/ (gitignored) so it
#   survives shell restarts and direnv reloads, and stays per-checkout.
# - Defaults for profile/region can be overridden by env vars at call
#   time; a teammate with their own AWS setup just exports AWS_PROFILE
#   before running any helper.

set -euo pipefail

AWS_WIN_PROFILE="${AWS_PROFILE:-dev.urandom.io}"
AWS_WIN_REGION="${AWS_REGION:-us-west-2}"

# $PRJ_ROOT is set by numtide/devshell; fall back to git toplevel for
# callers outside the devshell (tests, manual runs).
: "${PRJ_ROOT:=$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PRJ_ROOT/.claudette/aws-win"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

aws_() { aws --profile "$AWS_WIN_PROFILE" --region "$AWS_WIN_REGION" "$@"; }

log() { echo "[${0##*/}] $*" >&2; }

# Newest running claudette-spinup instance id, or empty.
discover_instance() {
  local id
  id=$(aws_ ec2 describe-instances \
    --filters "Name=tag:Project,Values=claudette-spinup" \
              "Name=instance-state-name,Values=running" \
    --query 'sort_by(Reservations[].Instances[], &LaunchTime)[-1].InstanceId' \
    --output text 2>/dev/null || true)
  [ "$id" = "None" ] && id=""
  printf '%s' "$id"
}

instance_public_ip() {
  aws_ ec2 describe-instances --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
}

# State file helpers — one per instance, so multiple instances don't stomp.
state_file() { printf '%s/%s.%s' "$STATE_DIR" "$1" "$2"; }
