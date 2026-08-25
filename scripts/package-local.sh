#!/usr/bin/env bash
set -euo pipefail

# package-local.sh — build @sow/desktop from source and package it as an
# UNSIGNED, LOCAL, directory-only macOS app (task 11.6, unpacked — never a
# signed, Apple-verified installer image).
#
# This script NEVER signs the build, NEVER submits it to Apple for
# post-signing verification, and NEVER pushes it to a distribution target.
# It runs no afterSign hook, reads no signing-identity or Apple-ID
# credential environment variables, and passes the CLI no flag that would
# ship the result anywhere. The resulting .app is unsigned: on first
# launch, macOS Gatekeeper will refuse a plain double-click — the user must
# right-click the .app and choose "Open" (or run
# `xattr -dr com.apple.quarantine <path>`) once. A signed, Apple-verified
# build requires a Developer certificate this project does not hold and is
# deliberately out of scope (see apps/desktop/electron-builder.config.ts).
#
# electron-builder is intentionally NOT a devDependency of @sow/desktop (this
# work package may not touch apps/desktop/package.json — another wave owns
# every package.json this round), so the CLI is invoked via a pinned
# `pnpm dlx` instead of a floating version. Re-pin deliberately, never widen
# to `@latest`.
ELECTRON_BUILDER_VERSION="26.15.3"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="${REPO_ROOT}/apps/desktop"

echo "[package-local] building @sow/desktop from source..."
pnpm --filter @sow/desktop build

echo "[package-local] packaging (unsigned, unpacked, electron-builder@${ELECTRON_BUILDER_VERSION})..."
(
  cd "${DESKTOP_DIR}"
  pnpm dlx "electron-builder@${ELECTRON_BUILDER_VERSION}" --dir --config electron-builder.config.ts
)

echo "[package-local] done: ${DESKTOP_DIR}/release/mac-arm64/System of Work.app"
