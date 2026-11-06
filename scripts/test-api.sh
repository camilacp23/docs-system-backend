#!/usr/bin/env bash
# API tests with the Bruno collection (bruno/docs-system-api) on the isolated database docs_sandbox.
# Recreates docs_sandbox, starts the local Jira simulator (port 3002) and the API (port 3001), runs the collection with the
# Bruno CLI and ALWAYS stops both processes (by PID) and drops docs_sandbox on the way out (trap), even when an assertion fails or the script is interrupted.
# Runs in Git Bash (Windows) and Linux. Never touches docs_system and never prints a password.
#
# Usage:   npm run test:api
# Exit code: 0 only if every request and assertion of the collection passed (2 = could not run).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

PORT=3001
JIRA_SIM_PORT=3002
ENV_FILE="bruno/docs-system-api/.env"
BASE_URL="http://localhost:${PORT}/api/v1"
START_TIMEOUT_SECONDS=90
LOG="$(mktemp)"
JIRA_LOG="$(mktemp)"
API_PID=""
JIRA_PID=""
BRU_PID=""
DROP_DB=0

# Anything that answers HTTP on the sandbox port (the API, or another process): curl exits 0 on any HTTP response.
answers() { curl -s -o /dev/null --max-time 2 "$BASE_URL/users"; }
# Same for the Jira simulator (its control endpoint answers without credentials).
jiraAnswers() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${JIRA_SIM_PORT}/__sim/state"; }

# stopProcess PID: asks it to stop, waits up to 10 s, then forces it (and its children).
stopProcess() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      # Git Bash: a native Windows process may ignore the signal; end it (and its children) through Windows.
      WINPID="$(cat "/proc/$pid/winpid" 2>/dev/null || true)"
      if [ -n "$WINPID" ]; then taskkill //PID "$WINPID" //T //F >/dev/null 2>&1; else kill -9 "$pid" 2>/dev/null; fi
    fi
  fi
  wait "$pid" 2>/dev/null
}

cleanup() {
  local status=$?
  # An interrupted DROP DATABASE would leave an invalid database behind: ignore further INT/TERM while cleaning.
  trap '' INT TERM
  trap - EXIT
  stopProcess "$BRU_PID"
  stopProcess "$API_PID"
  stopProcess "$JIRA_PID"
  if [ "$DROP_DB" -eq 1 ]; then
    npx --no-install tsx scripts/sandbox-db.ts --drop >/dev/null 2>&1 || echo "WARNING: could not drop docs_sandbox" >&2
  fi
  rm -f "$LOG" "$JIRA_LOG"
  exit "$status"
}
trap cleanup EXIT INT TERM

command -v node >/dev/null || { echo "node not found in PATH" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl not found in PATH" >&2; exit 2; }

if answers; then
  echo "Port $PORT already answers (is 'npm run sandbox:api' running?). Stop it and try again." >&2
  exit 2
fi

if jiraAnswers; then
  echo "Port $JIRA_SIM_PORT already answers (is 'npm run sandbox:jira' running?). Stop it and try again." >&2
  exit 2
fi

DROP_DB=1
echo "Recreating docs_sandbox ..."
npx --no-install tsx scripts/sandbox-db.ts >"$LOG" 2>&1 || { cat "$LOG" >&2; exit 2; }

# Safeguard: Bruno, the sandbox API and the simulator only ever talk to a LOCAL Jira. Only the URL line is read
# from the generated credentials file (the secrets in it are never printed).
JIRA_URL="$(grep -m1 '^SANDBOX_JIRA_BASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
if ! printf '%s' "$JIRA_URL" | grep -Eq '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?/?$'; then
  echo "Refusing to run: SANDBOX_JIRA_BASE_URL is missing or does not point to localhost or 127.0.0.1." >&2
  exit 2
fi

echo "Starting the Jira simulator on port $JIRA_SIM_PORT ..."
node --import tsx scripts/sandbox-jira.ts >"$JIRA_LOG" 2>&1 &
JIRA_PID=$!
for ((i = 0; i < START_TIMEOUT_SECONDS; i++)); do
  jiraAnswers && break
  if ! kill -0 "$JIRA_PID" 2>/dev/null; then
    echo "The Jira simulator stopped while starting:" >&2
    cat "$JIRA_LOG" >&2
    exit 2
  fi
  sleep 1
done
if ! jiraAnswers; then
  echo "The Jira simulator did not answer within ${START_TIMEOUT_SECONDS} s:" >&2
  cat "$JIRA_LOG" >&2
  exit 2
fi

echo "Starting the API on port $PORT ..."
node --import tsx scripts/sandbox-api.ts >"$LOG" 2>&1 &
API_PID=$!
for ((i = 0; i < START_TIMEOUT_SECONDS; i++)); do
  answers && break
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "The API stopped while starting:" >&2
    cat "$LOG" >&2
    exit 2
  fi
  sleep 1
done
if ! answers; then
  echo "The API did not answer within ${START_TIMEOUT_SECONDS} s:" >&2
  cat "$LOG" >&2
  exit 2
fi

echo "Running the Bruno collection ..."
# In the background and awaited with `wait`, so Ctrl+C (or SIGTERM) reaches the trap at once instead of after bru ends.
(cd bruno/docs-system-api && exec node ../../node_modules/@usebruno/cli/bin/bru.js run --env sandbox -r) &
BRU_PID=$!
wait "$BRU_PID"
CODE=$?
BRU_PID=""

if [ "$CODE" -eq 0 ]; then echo "test:api: all requests and assertions passed"; else echo "test:api: FAILED (bru exit $CODE)" >&2; fi
exit "$CODE"
