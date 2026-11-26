#!/usr/bin/env bash
# BB runs this in each new worktree of this repo (bb guide environments), so
# improvement workers can typecheck and build. Non-fatal: a failed install
# should not block the worktree.
set -uo pipefail
npm ci --no-audit --no-fund --loglevel=error || echo "npm ci failed; run it manually before building."
