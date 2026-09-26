#!/usr/bin/env bash
# Fails if files that must never be versioned are tracked by git
# (environment files, private keys, database dumps).
# Only file *names* are checked; file contents are never printed.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

forbidden_patterns=(
  '(^|/)\.env$'
  '(^|/)\.env\.(?!example$)[^/]+$'
  '\.(pem|key|p12|pfx|jks|keystore)$'
  '(^|/)id_(rsa|dsa|ecdsa|ed25519)$'
  '\.(sqlite3?|db|dump)$'
  '\.sql\.gz$'
  '\.tfstate(\..*)?$'
)

# Tracked files plus staged additions (so the check also works before a commit).
files="$(git ls-files --cached)"

violations=""
for pattern in "${forbidden_patterns[@]}"; do
  matches="$(printf '%s\n' "$files" | grep -P -- "$pattern" || true)"
  if [[ -n "$matches" ]]; then
    violations+="$matches"$'\n'
  fi
done

if [[ -n "${violations//$'\n'/}" ]]; then
  echo "ERROR: forbidden files are tracked by git:" >&2
  printf '%s' "$violations" | sort -u | sed 's/^/  - /' >&2
  echo "Remove them from the index (git rm --cached <file>) and rotate any exposed secrets." >&2
  exit 1
fi

echo "OK: no forbidden files tracked ($(printf '%s\n' "$files" | grep -c . || true) files checked)."
