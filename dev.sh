#!/usr/bin/env bash
# Launch the SoW desktop app in dev mode.
# The app now NATIVELY loads a repo-root `.env` in Electron main (task 18.34,
# apps/desktop/main/dotenv-allowlist.ts) — hydrating ONLY the recognized SOW_*
# config allowlist (never blanket; the subscription-shadowing env set + all
# secrets are STRUCTURALLY excluded). The old shell-side `source .env` was a
# blanket source (a shadowing / secret-egress risk) and is intentionally gone.
# See .env.example for the recognized keys.
set -euo pipefail
cd "$(dirname "$0")"

exec pnpm --filter @sow/desktop dev
