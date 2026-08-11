#!/usr/bin/env bash
# Drive every fixture through a running Expense Guard dev server and print one line
# each: fixture, ok, decision, cited_rule.
#
# Requires `bunx eve dev` to already be running. That binds 127.0.0.1:2000 by
# default; override with PORT=xxxx ./scripts/check.sh
set -uo pipefail

PORT="${PORT:-2000}"
URL="http://localhost:${PORT}/eve/v1/review"

cd "$(dirname "$0")/.." || exit 1

shopt -s nullglob
fixtures=(fixtures/*.json)
if [ ${#fixtures[@]} -eq 0 ]; then
  echo "No fixtures found under fixtures/." >&2
  exit 1
fi

printf '%-24s %-6s %-16s %s\n' FIXTURE OK DECISION CITED_RULE
printf '%-24s %-6s %-16s %s\n' ------- -- -------- ----------

status=0
for f in "${fixtures[@]}"; do
  name=$(basename "$f")

  # Split the HTTP status off the tail of the response so transport-level and
  # application-level failures stay distinguishable.
  response=$(curl -sS -m 180 -w $'\n%{http_code}' -X POST "$URL" \
    -H 'content-type: application/json' \
    --data-binary "@$f" 2>&1)
  curl_rc=$?

  if [ $curl_rc -ne 0 ]; then
    printf '%-24s %-6s %-16s %s\n' "$name" "-" "-" "curl failed (rc=$curl_rc): ${response//$'\n'/ }"
    status=1
    continue
  fi

  code="${response##*$'\n'}"
  body="${response%$'\n'*}"

  if ! ok=$(printf '%s' "$body" | jq -r '.ok // false' 2>/dev/null); then
    printf '%-24s %-6s %-16s %s\n' "$name" "-" "-" "HTTP $code, non-JSON body: ${body:0:80}"
    status=1
    continue
  fi

  if [ "$ok" != "true" ]; then
    err=$(printf '%s' "$body" | jq -r '.error // "unknown error"')
    printf '%-24s %-6s %-16s %s\n' "$name" "false" "-" "HTTP $code: $err"
    status=1
    continue
  fi

  decision=$(printf '%s' "$body" | jq -r '.data.decision // "-"')
  cited=$(printf '%s' "$body" | jq -r '.data.cited_rule // "-"')
  printf '%-24s %-6s %-16s %s\n' "$name" "true" "$decision" "$cited"
done

exit $status
