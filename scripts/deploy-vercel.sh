#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-command Vercel deploy for the Patient Statement Generator.
#
# Installs the Vercel CLI if needed, signs you in (interactive — only YOU can do
# this), links the folder to your Vercel project, pushes every variable from the
# root .env into Production + Preview, then deploys to production.
#
#   bash scripts/deploy-vercel.sh
#
# The env-var upload is driven by ./.env (git-ignored). Make sure that file holds
# your real production values before running.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v vercel >/dev/null 2>&1; then
  echo "→ Installing Vercel CLI (npm i -g vercel)…"
  npm i -g vercel
fi

echo "→ Signing in to Vercel (a browser window will open)…"
vercel whoami >/dev/null 2>&1 || vercel login

echo "→ Linking this folder to your Vercel project…"
[ -f .vercel/project.json ] || vercel link

echo "→ Pushing environment variables from ./.env …"
bash scripts/push-vercel-env.sh

echo "→ Deploying to production…"
vercel --prod

echo ""
echo "✔ Done. After the deploy finishes, set CLIENT_ORIGIN to your live URL if you"
echo "  haven't already:  vercel env add CLIENT_ORIGIN production   (then redeploy)."
