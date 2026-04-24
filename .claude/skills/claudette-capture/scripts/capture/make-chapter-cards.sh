#!/usr/bin/env bash
# Generates intro / outro / chapter cards with Claudette brand accent.
# Output: /tmp/claudette-capture/slides/*.mp4 (all 1920x1136, 60fps, yuv420p)

set -euo pipefail

FONT="/System/Library/Fonts/SFCompact.ttf"
FONT_ROUND="/System/Library/Fonts/SFCompactRounded.ttf"
[[ -f "$FONT_ROUND" ]] || FONT_ROUND="$FONT"

ACCENT="0xe07850"         # Claudette default-dark accent (coral)
BG="0x0f0e0d"             # warm charcoal
FG="0xe8e6e3"             # cream
MUTED="0x6e6a65"          # dim

OUT=/tmp/claudette-capture/slides
mkdir -p "$OUT"

# make_card <out_file> <duration> <small_prefix> <big_title> <subtitle>
make_card() {
  local file="$1" dur="$2" prefix="$3" title="$4" sub="$5"
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "color=c=${BG}:s=1920x1136:d=${dur}:r=60" \
    -vf "\
drawtext=fontfile=${FONT}:text='${prefix}':fontcolor=${ACCENT}:fontsize=24:x=(w-tw)/2:y=(h/2)-160,\
drawtext=fontfile=${FONT_ROUND}:text='${title}':fontcolor=${FG}:fontsize=128:x=(w-tw)/2:y=(h/2)-80,\
drawbox=x=900:y=638:w=120:h=3:color=${ACCENT}:t=fill,\
drawtext=fontfile=${FONT}:text='${sub}':fontcolor=${MUTED}:fontsize=34:x=(w-tw)/2:y=(h/2)+110" \
    -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -an \
    "$file"
}

# Intro — "Claudette" with a tagline
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=${BG}:s=1920x1136:d=2.4:r=60" \
  -vf "\
drawtext=fontfile=${FONT}:text='a native workbench':fontcolor=${MUTED}:fontsize=30:x=(w-tw)/2:y=(h/2)-170,\
drawtext=fontfile=${FONT_ROUND}:text='Claudette':fontcolor=${FG}:fontsize=196:x=(w-tw)/2:y=(h/2)-110,\
drawbox=x=870:y=678:w=180:h=4:color=${ACCENT}:t=fill,\
drawtext=fontfile=${FONT}:text='for Claude agents':fontcolor=${ACCENT}:fontsize=32:x=(w-tw)/2:y=(h/2)+140" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -an \
  "$OUT/intro.mp4"

# Outro — "Claudette" mark with a subtle URL
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=${BG}:s=1920x1136:d=3.0:r=60" \
  -vf "\
drawtext=fontfile=${FONT_ROUND}:text='Claudette':fontcolor=${FG}:fontsize=180:x=(w-tw)/2:y=(h/2)-100,\
drawbox=x=880:y=673:w=160:h=4:color=${ACCENT}:t=fill,\
drawtext=fontfile=${FONT}:text='utensils.io/claudette':fontcolor=${MUTED}:fontsize=32:x=(w-tw)/2:y=(h/2)+135" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -an \
  "$OUT/outro.mp4"

# Chapter cards (shorter, 1.7s each) — with small letter-spaced eyebrow label
make_card "$OUT/ch-workspace.mp4"   1.7 "ONE" "workspaces"          "parallel agents\, isolated worktrees"
make_card "$OUT/ch-plan.mp4"        1.7 "TWO" "plan mode"           "approve before the agent writes a line"
make_card "$OUT/ch-terminal.mp4"    1.7 "THREE" "integrated terminal" "watch the agent work in real time"
make_card "$OUT/ch-scm.mp4"         1.7 "FOUR" "SCM built in"       "commits\, branches\, PRs — first class"
make_card "$OUT/ch-usage.mp4"       1.7 "FIVE" "usage insights"     "tokens\, spend\, budgets at a glance"
make_card "$OUT/ch-site.mp4"        1.7 "SIX" "the real output"     "Claude shipped a site"

ls -lh "$OUT"/*.mp4
