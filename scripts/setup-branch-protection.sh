#!/usr/bin/env bash
# Configure the OUTER GUARD for the autonomous self-maintainer: make the `ci` status check
# (see .github/workflows/ci.yml) REQUIRED before anything merges to main, and enable
# auto-merge so a canary-verified maintainer fix merges automatically once CI passes.
#
# Run ONCE, with a token that has admin on the repo:
#   GITHUB_TOKEN=<admin-token> ./scripts/setup-branch-protection.sh [owner/repo]
#
# We intentionally do NOT require human PR reviews: the gate is CI + the orchestrator's own
# layered safety gates (justification, scope/protected-path, size, rate, self-test, canary),
# because the whole point is autonomous self-repair. The required `ci` check is the outer,
# server-side guarantee that a fix failing typecheck/tests can never land on main.
set -euo pipefail

REPO="${1:-ArielFalcon/ai-pipeline}"
: "${GITHUB_TOKEN:?set GITHUB_TOKEN (needs admin on the repo)}"

api() {
  local method="$1" path="$2"
  shift 2
  curl -fsSL -X "$method" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/${path}" "$@"
}

# Allow auto-merge, and guarantee squash merges are enabled (the promote path merges with the
# SQUASH method — both the native auto-merge and the fallback — so this keeps it deterministic).
echo "→ enabling 'Allow auto-merge' + squash merges on ${REPO}"
api PATCH "repos/${REPO}" -d '{"allow_auto_merge":true,"allow_squash_merge":true}' >/dev/null

# strict:false on purpose — "strict" requires a PR to be up to date with main before merging,
# which an autonomous bot cannot satisfy (it does not rebase its own PR), so it would deadlock if
# main advanced during CI. The `ci` check still runs on the PR head, which is the guarantee we want.
echo "→ requiring the 'ci' status check on ${REPO}@main (enforced on admins)"
api PUT "repos/${REPO}/branches/main/protection" -d '{
  "required_status_checks": { "strict": false, "contexts": ["ci"] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}' >/dev/null

echo "✓ outer guard configured: main now requires the 'ci' check; auto-merge enabled."
