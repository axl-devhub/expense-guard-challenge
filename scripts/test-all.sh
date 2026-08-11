#!/usr/bin/env bash
# The whole deterministic suite in one command: typecheck, then every scripts/*.test.ts.
#
# Deliberately does NOT run `bunx eve eval`. Those evals drive a real model through the
# Vercel AI Gateway — they need AI_GATEWAY_API_KEY and they spend tokens on every run, so
# they cannot be a push-triggered check. Run them by hand with `bunx eve eval`.
#
# Usage: bun run test   (or ./scripts/test-all.sh)
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.bun/bin:$PATH"

failed=0

echo "==> tsc --noEmit"
if bunx tsc --noEmit; then
  echo "    ok"
else
  echo "    FAILED"
  failed=1
fi
echo

shopt -s nullglob
suites=(scripts/*.test.ts)
if [ ${#suites[@]} -eq 0 ]; then
  echo "No test suites found under scripts/." >&2
  exit 1
fi

for suite in "${suites[@]}"; do
  echo "==> $suite"
  # Indent each suite's output so the overall run stays readable. `pipefail` (set above)
  # makes the pipeline carry bun's exit status rather than sed's, which is always 0.
  if ! bun run "$suite" 2>&1 | sed 's/^/    /'; then
    failed=1
  fi
  echo
done

if [ "$failed" -ne 0 ]; then
  echo "FAILED — at least one check did not pass."
  exit 1
fi

echo "All deterministic checks passed."
echo "Note: bunx eve eval is NOT included here (needs a gateway key, spends tokens)."
