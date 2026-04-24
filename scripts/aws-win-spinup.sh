#!/usr/bin/env bash
# Spin up an ephemeral, publicly-reachable Windows Server EC2 instance
# with OpenSSH enabled + the caller's pubkey pre-authorized + a known
# Administrator password baked in via user-data.
#
# Usage (eval-free path — recommended):
#   aws-win-spinup               # launches, stashes state, returns
#   aws-win-rdp                  # auto-discovers the instance
#   deploy-win-x64               # auto-discovers the instance
#   aws-win-destroy              # tears down + scrubs state
#
# Optional eval path (for callers that want env vars set in their
# current shell): `eval "$(aws-win-spinup)"`. Downstream helpers work
# either way — they fall back to $PRJ_ROOT/.claudette/aws-win/ and AWS
# tag lookup when env vars aren't set. State survives shell/direnv
# reloads because it lives under the project, not $TMPDIR.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_aws-common.sh
source "$SCRIPT_DIR/_aws-common.sh"

# Fallback chain for the default pubkey: ed25519 (99% of dev Macs),
# then rsa, then the legacy project key. SPINUP_PUB_KEY overrides.
if [ -n "${SPINUP_PUB_KEY:-}" ]; then
  PUB_KEY_FILE="$SPINUP_PUB_KEY"
elif [ -r "$HOME/.ssh/id_ed25519.pub" ]; then
  PUB_KEY_FILE="$HOME/.ssh/id_ed25519.pub"
elif [ -r "$HOME/.ssh/id_rsa.pub" ]; then
  PUB_KEY_FILE="$HOME/.ssh/id_rsa.pub"
else
  PUB_KEY_FILE="$HOME/.ssh/dev.urandom.io.pub"
fi
SG_NAME="${SPINUP_SG_NAME:-claudette-spinup-sg}"
INSTANCE_TYPE="${SPINUP_INSTANCE_TYPE:-t3.medium}"
NAME_TAG="${SPINUP_NAME_TAG:-claudette-spinup-$(date +%Y%m%d-%H%M%S)}"
AMI_FILTER="${SPINUP_AMI_FILTER:-Windows_Server-2022-English-Full-Base-*}"
# Admin password: 32 hex chars + Aa1! to hit all four Windows
# local-policy character classes without introducing characters that
# need PowerShell escaping.
ADMIN_PASS="${SPINUP_ADMIN_PASSWORD:-$(openssl rand -hex 16)Aa1!}"

[ -r "$PUB_KEY_FILE" ] || { log "pubkey $PUB_KEY_FILE not readable"; exit 1; }
PUBKEY=$(cat "$PUB_KEY_FILE")
log "pubkey: $PUB_KEY_FILE"

# No EC2 key pair is imported: ed25519 is rejected for Windows AMIs
# ("ED25519 key pairs are not supported with Windows AMIs") and we
# don't need one because user-data installs the pubkey directly. Side
# benefit: get-password-data becomes a non-option, forcing the simpler
# user-data-password path.

# 1. Security group: 22 + 3389 open to 0.0.0.0/0 (ephemeral).
VPC_ID=$(aws_ ec2 describe-vpcs \
  --filters "Name=is-default,Values=true" \
  --query 'Vpcs[0].VpcId' --output text)
[ "$VPC_ID" != "None" ] || { log "no default VPC in $AWS_WIN_REGION"; exit 1; }
SG_ID=$(aws_ ec2 describe-security-groups \
  --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  log "creating security group $SG_NAME in $VPC_ID"
  SG_ID=$(aws_ ec2 create-security-group \
    --group-name "$SG_NAME" \
    --description "Claudette ephemeral Windows test SG (SSH+RDP public)" \
    --vpc-id "$VPC_ID" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=claudette-spinup}]" \
    --query 'GroupId' --output text)
  aws_ ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions \
      'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=0.0.0.0/0,Description=ssh}]' \
      'IpProtocol=tcp,FromPort=3389,ToPort=3389,IpRanges=[{CidrIp=0.0.0.0/0,Description=rdp}]' \
    >/dev/null
fi
log "security group: $SG_ID"

# 2. Latest Windows Server 2022 AMI (amazon-owned).
AMI_ID=$(aws_ ec2 describe-images --owners amazon \
  --filters "Name=name,Values=$AMI_FILTER" "Name=architecture,Values=x86_64" "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)
[ -n "$AMI_ID" ] && [ "$AMI_ID" != "None" ] || { log "no AMI matching $AMI_FILTER"; exit 1; }
log "AMI: $AMI_ID"

# 3. Render user-data. EC2Launch v2 runs the <powershell> block once on
# first boot; Windows Server 2022 ships OpenSSH Server pre-installed.
USER_DATA=$(mktemp)
trap 'rm -f "$USER_DATA"' EXIT
cat > "$USER_DATA" <<EOF
<powershell>
\$ErrorActionPreference = 'Stop'
try {
  # Pin the Administrator password first so RDP is usable even if the
  # rest of the block fails. PowerShell single-quote string is literal,
  # and ADMIN_PASS only contains hex + Aa1! so no escaping needed.
  net user Administrator '$ADMIN_PASS' | Out-Null

  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction SilentlyContinue | Out-Null
  Set-Service -Name sshd -StartupType Automatic
  Start-Service sshd
  if (!(Test-Path 'C:\ProgramData\ssh')) { New-Item -ItemType Directory -Path 'C:\ProgramData\ssh' | Out-Null }
  \$authKey = 'C:\ProgramData\ssh\administrators_authorized_keys'
  \$pub = @'
$PUBKEY
'@
  Set-Content -Path \$authKey -Value \$pub -Encoding ascii
  icacls.exe \$authKey /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
  if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -PropertyType String -Force | Out-Null
  Restart-Service sshd
} catch {
  Write-Host "user-data error: \$_"
  throw
}
</powershell>
<persist>false</persist>
EOF

# 4. Launch. Intentionally no --key-name (see note above).
log "launching $INSTANCE_TYPE ($NAME_TAG)"
INSTANCE_ID=$(aws_ ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --security-group-ids "$SG_ID" \
  --user-data "file://$USER_DATA" \
  --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=50,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications \
    "ResourceType=instance,Tags=[{Key=Project,Value=claudette-spinup},{Key=Name,Value=$NAME_TAG}]" \
    "ResourceType=volume,Tags=[{Key=Project,Value=claudette-spinup},{Key=Name,Value=$NAME_TAG}]" \
  --query 'Instances[0].InstanceId' --output text)
log "instance: $INSTANCE_ID — waiting for running state"
aws_ ec2 wait instance-running --instance-ids "$INSTANCE_ID"

# 5. Poll for public IP assignment. EC2 reports `running` as soon as
# the hypervisor boots the instance, but the public IP can lag by a
# few seconds. Capture the IP in a short loop rather than reading it
# once and risking an empty/None value driving the sshd poll below.
PUBLIC_IP=""
IP_DEADLINE=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$IP_DEADLINE" ]; do
  PUBLIC_IP=$(instance_public_ip "$INSTANCE_ID")
  [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "None" ] && break
  sleep 3
done
if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" = "None" ]; then
  log "timed out waiting for public IP assignment on $INSTANCE_ID"
  exit 1
fi
log "public IP: $PUBLIC_IP — waiting for sshd (Windows first-boot + user-data is slow, ~5-8 min)"

# 6. Poll sshd via ssh-keyscan (no auth needed — just confirms sshd
# finished starting, which on Windows is the slow part). Accept any
# host key type: Windows OpenSSH generates rsa+ecdsa+ed25519 by
# default today, but we shouldn't bind to that detail.
DEADLINE=$(( $(date +%s) + 900 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ssh-keyscan -T 5 "$PUBLIC_IP" 2>/dev/null \
       | awk 'NF >= 3 && $2 ~ /^(ssh|ecdsa)/ { found=1; exit } END { exit !found }'; then
    log "sshd ready"
    break
  fi
  sleep 15
done
if [ "$(date +%s)" -ge "$DEADLINE" ]; then
  log "timed out waiting for sshd on $PUBLIC_IP (instance $INSTANCE_ID)"
  log "inspect with: aws --profile $AWS_WIN_PROFILE --region $AWS_WIN_REGION ec2 get-console-output --instance-id $INSTANCE_ID --latest --output text"
  exit 1
fi

# 7. Persist instance info to the project-scoped state dir so
# downstream helpers work from any shell, including after a
# direnv reload. Password is in a mode-600 sidecar.
( umask 077; printf '%s' "$ADMIN_PASS" > "$(state_file "$INSTANCE_ID" pass)" )
printf '%s\n' "$INSTANCE_ID" > "$STATE_DIR/current"

# 8. Emit exports on stdout so `eval "$(aws-win-spinup)"` works for
# callers who want env vars. The password is deliberately NOT included
# here: it would leak into terminal scrollback and shell/CI logs for
# the common non-eval invocation. aws-win-rdp reads it from the mode-
# 600 sidecar, and anyone who wants it in their shell can run
# `cat $PRJ_ROOT/.claudette/aws-win/<id>.pass` or read $PASS_FILE.
cat <<EOF
export CLAUDETTE_WIN_HOST=Administrator@$PUBLIC_IP
export CLAUDETTE_WIN_REMOTE_PATH=Desktop/claudette.exe
export CLAUDETTE_WIN_INSTANCE_ID=$INSTANCE_ID
# Host:    $PUBLIC_IP
# SSH:     ssh Administrator@$PUBLIC_IP
# RDP:     aws-win-rdp            # macOS; opens Windows App with password on clipboard
# Deploy:  deploy-win-x64
# Destroy: aws-win-destroy
# Admin password is in $STATE_DIR/$INSTANCE_ID.pass (mode 600).
EOF
