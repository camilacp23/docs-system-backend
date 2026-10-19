#!/usr/bin/env bash
# Phase 2 regression suite (tests 01-10, 153 checks) on disposable copies of a database.
# Runs in Git Bash (Windows) and Linux (CI). It does not modify any test file and contains no passwords.
#
# Usage:   npm run test:legacy        (or: bash scripts/test-legacy.sh)
#
# Environment (all optional):
#   LEGACY_SOURCE_DB       database copied for every test (default: docs_system). Only copied, never written to.
#   LEGACY_MAINTENANCE_DB  database used to run CREATE/DROP DATABASE (default: postgres)
#   PGHOST / PGPORT        server (default: localhost / 5432)
#   LEGACY_OWNER_USER      default docs_owner (needs CREATEDB; creates and drops the copies; test 03)
#   LEGACY_APP_USER        default docs_app   (the API role; tests 02, 04, 07)
#   LEGACY_SUPERUSER       default postgres   (tests 01, 04 admin connection, 09, 10)
# Credentials: ~/.pgpass (Windows: %APPDATA%\postgresql\pgpass.conf), or the environment variables
#   PGPASSWORD_OWNER, PGPASSWORD_APP, PGPASSWORD_SUPERUSER (read only; one per role), or a single PGPASSWORD.
#
# Exit code: 0 only if every PASS count and the test 10 table match the expected values.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

SOURCE_DB="${LEGACY_SOURCE_DB:-docs_system}"
MAINT_DB="${LEGACY_MAINTENANCE_DB:-postgres}"
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
OWNER_USER="${LEGACY_OWNER_USER:-docs_owner}"
APP_USER="${LEGACY_APP_USER:-docs_app}"
SUPER_USER="${LEGACY_SUPERUSER:-postgres}"
export PSQL_PAGER=cat

# Expected number of PASS lines per test (README of Phase 2, test-results/RESUMEN.md): 153 in total.
EXPECTED_01=37 EXPECTED_02=22 EXPECTED_03=3 EXPECTED_04=11 EXPECTED_05=9
EXPECTED_06=15 EXPECTED_07=35 EXPECTED_08=14 EXPECTED_09=7

PASS_RE='^(psql:[^ ]*: NOTICE:  )?PASS([[:space:]]|$)'
FAIL_RE='^(psql:[^ ]*: NOTICE:  )?FAIL([[:space:]]|$)'

WORK="$(mktemp -d)"
CREATED=()
RUN_ID="$(printf '%04x%04x' "$RANDOM" "$RANDOM")"
PROBLEMS=0
TOTAL_PASS=0

# Runs "$@" with the password of one role (PGPASSWORD_<ROLE>) when provided; otherwise pgpass / PGPASSWORD apply.
as_role() {
  local var="PGPASSWORD_$1"
  shift
  if [ -n "${!var:-}" ]; then PGPASSWORD="${!var}" "$@"; else "$@"; fi
}
psql_as() { # psql_as ROLE USER DB [psql args...]
  local role="$1" user="$2" db="$3"
  shift 3
  as_role "$role" psql -X -q -h "$PGHOST" -p "$PGPORT" -U "$user" -d "$db" "$@"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  local db
  for db in "${CREATED[@]:-}"; do
    [ -n "$db" ] || continue
    case "$db" in
      docs_legacy_*) psql_as OWNER "$OWNER_USER" "$MAINT_DB" -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 \
        || echo "WARNING: could not drop disposable database $db" >&2 ;;
    esac
  done
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT INT TERM

command -v psql >/dev/null || { echo "psql not found in PATH" >&2; exit 2; }
command -v node >/dev/null || { echo "node not found in PATH" >&2; exit 2; }

# newCopy NN -> creates a disposable copy of $SOURCE_DB and stores its name in DB_COPY
# (no command substitution: the name must be registered in CREATED for the cleanup trap).
newCopy() {
  local name="docs_legacy_${RUN_ID}_$1"
  CREATED+=("$name")
  DB_COPY="$name"
  if ! psql_as OWNER "$OWNER_USER" "$MAINT_DB" -c "CREATE DATABASE \"$name\" TEMPLATE \"$SOURCE_DB\"" >/dev/null 2>"$WORK/create.err"; then
    echo "Could not create a copy of $SOURCE_DB (is anybody connected to it? does $OWNER_USER have CREATEDB?):" >&2
    cat "$WORK/create.err" >&2
    exit 2
  fi
}

# check NN LABEL EXPECTED OUTPUT_FILE [EXIT_CODE]
check() {
  local nn="$1" label="$2" expected="$3" file="$4" code="${5:-0}"
  local pass fail
  pass="$(grep -Ec "$PASS_RE" "$file" || true)"
  fail="$(grep -Ec "$FAIL_RE" "$file" || true)"
  TOTAL_PASS=$((TOTAL_PASS + pass))
  if [ "$pass" -eq "$expected" ] && [ "$fail" -eq 0 ] && [ "$code" -eq 0 ]; then
    printf 'OK    %s %-48s PASS %s/%s\n' "$nn" "$label" "$pass" "$expected"
  else
    printf 'DIFF  %s %-48s PASS %s/%s, FAIL %s, exit %s\n' "$nn" "$label" "$pass" "$expected" "$fail" "$code"
    PROBLEMS=$((PROBLEMS + 1))
  fi
}

echo "Phase 2 regression suite on disposable copies of '$SOURCE_DB' (run $RUN_ID)"

# url_for ROLE USER DB: connection URL for the Node tests. The password is included only when the matching
# PGPASSWORD_<ROLE> variable is set (URL-encoded, never printed); otherwise the pg driver uses pgpass / PGPASSWORD.
url_for() {
  local var="PGPASSWORD_$1" auth="$2"
  if [ -n "${!var:-}" ]; then
    auth="$2:$(PW="${!var}" node -e "process.stdout.write(encodeURIComponent(process.env.PW))")"
  fi
  echo "postgresql://$auth@$PGHOST:$PGPORT/$3"
}

# 01 integrity (superuser)
newCopy 01; db="$DB_COPY"
psql_as SUPERUSER "$SUPER_USER" "$db" -f tests/01_integrity_tests.sql >"$WORK/01.txt" 2>&1
check 01 "Model integrity" "$EXPECTED_01" "$WORK/01.txt" 0

# 02 audit and privileges (docs_app) + 03 owner immutability (docs_owner), same copy
newCopy 02; db="$DB_COPY"
psql_as APP "$APP_USER" "$db" -f tests/02_audit_privilege_tests.sql >"$WORK/02.txt" 2>&1
check 02 "Audit and privileges (docs_app)" "$EXPECTED_02" "$WORK/02.txt" 0
psql_as OWNER "$OWNER_USER" "$db" -f tests/03_owner_immutability_tests.sql >"$WORK/03.txt" 2>&1
check 03 "Insert-only audit_log (docs_owner)" "$EXPECTED_03" "$WORK/03.txt" 0

# 04 audit end to end with Prisma
newCopy 04; db="$DB_COPY"
APP_URL="$(url_for APP "$APP_USER" "$db")" ADMIN_URL="$(url_for SUPERUSER "$SUPER_USER" "$db")" \
  npm run --silent test:audit-e2e >"$WORK/04.txt" 2>&1
code=$?
check 04 "Prisma audit end to end" "$EXPECTED_04" "$WORK/04.txt" "$code"

# 05 and 06 do not use the database
npm run --silent test:jira-signature >"$WORK/05.txt" 2>&1
check 05 "Jira webhook signature" "$EXPECTED_05" "$WORK/05.txt" $?
npm run --silent test:workflow >"$WORK/06.txt" 2>&1
check 06 "Documentation workflow" "$EXPECTED_06" "$WORK/06.txt" $?

# 07 authentication and RBAC (fresh copy: the login rate limit is per copy)
newCopy 07; db="$DB_COPY"
JWT_KEY_B64="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
APP_URL="$(url_for APP "$APP_USER" "$db")" OPENAPI=api/openapi.yaml JWT_KEYS="k2026a:$JWT_KEY_B64" \
  FRONTEND_ORIGIN=https://docs.local INTEGRATION_USER_EMAIL=integracion.jira@system.local \
  npm run --silent test:auth >"$WORK/07.txt" 2>&1
check 07 "Authentication, session and RBAC" "$EXPECTED_07" "$WORK/07.txt" $?

# 08 request validation against the contract
OPENAPI=api/openapi.yaml npm run --silent test:validation >"$WORK/08.txt" 2>&1
check 08 "Request validation (contract)" "$EXPECTED_08" "$WORK/08.txt" $?

# 09 dependency graph (superuser)
newCopy 09; db="$DB_COPY"
psql_as SUPERUSER "$SUPER_USER" "$db" -f tests/09_dependency_graph_tests.sql >"$WORK/09.txt" 2>&1
check 09 "Dependency graph query" "$EXPECTED_09" "$WORK/09.txt" 0

# 10 polymorphic comparison (superuser): compare the result table with test-results/10.txt.
# Only the first three columns (scenario, design, outcome) are compared; the free-text detail column carries
# server error messages whose wording can change between PostgreSQL versions.
newCopy 10; db="$DB_COPY"
psql_as SUPERUSER "$SUPER_USER" "$db" -f tests/10_polymorphic_comparison.sql >"$WORK/10.txt" 2>&1
table_of() {
  awk -F'|' 'NF >= 4 { for (i = 1; i <= 3; i++) gsub(/^[ \t]+|[ \t]+$/, "", $i); print $1 "|" $2 "|" $3 }' "$1" | tr -d '\r'
}
table_of "$WORK/10.txt" >"$WORK/10.actual"
table_of test-results/10.txt >"$WORK/10.expected"
rows="$(wc -l <"$WORK/10.actual" | tr -d ' ')"
if [ "$rows" -gt 1 ] && diff -u "$WORK/10.expected" "$WORK/10.actual" >"$WORK/10.diff"; then
  printf 'OK    10 %-48s table equal (%s rows)\n' "Polymorphic vs adopted model" "$rows"
else
  printf 'DIFF  10 %-48s table differs from test-results/10.txt (%s rows)\n' "Polymorphic vs adopted model" "$rows"
  head -40 "$WORK/10.diff" 2>/dev/null
  PROBLEMS=$((PROBLEMS + 1))
fi

echo "----"
if [ "$PROBLEMS" -eq 0 ]; then
  echo "ALL GOOD: $TOTAL_PASS PASS checks (tests 01-09) + table of test 10 match the Phase 2 evidence"
else
  echo "FAILED: $PROBLEMS test(s) differ from the expected Phase 2 results" >&2
  for f in 01 02 03 04 05 06 07 08 09; do
    if grep -Eq "$FAIL_RE" "$WORK/$f.txt"; then echo "--- FAIL lines in test $f"; grep -E "$FAIL_RE" "$WORK/$f.txt" | head -5; fi
  done
  exit 1
fi
