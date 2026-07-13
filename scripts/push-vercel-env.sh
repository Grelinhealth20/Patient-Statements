#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Pushes every variable from the root .env file into your linked Vercel project
# for the Production and Preview environments, non-interactively.
#
# Prerequisites:
#   npm i -g vercel   &&   vercel login   &&   vercel link
#
# Usage:
#   bash scripts/push-vercel-env.sh
# ---------------------------------------------------------------------------
set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"
TARGETS=("production" "preview")

if ! command -v vercel >/dev/null 2>&1; then
  echo "Vercel CLI not found. Install it with: npm i -g vercel" >&2
  exit 1
fi

while IFS= read -r line; do
  # skip blanks and comments
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  key="$(echo "$key" | xargs)"

  for target in "${TARGETS[@]}"; do
    # remove any existing value first so this script is re-runnable
    vercel env rm "$key" "$target" -y >/dev/null 2>&1 || true
    printf '%s' "$value" | vercel env add "$key" "$target" >/dev/null
    echo "  set $key ($target)"
  done
done < "$ENV_FILE"

echo "Done. Redeploy for changes to take effect:  vercel --prod"
