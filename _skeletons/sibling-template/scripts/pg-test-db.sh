#!/usr/bin/env sh
#
# Give the Postgres-dependent test lane a database with a CURRENT schema, and
# print its DSN.
#
# ## Why this exists
#
# `scripts/verify.sh` grew a `pg-test` check (#1089) because on 2026-08-02 nine
# of thirteen locally-catchable failing CI steps across the estate were one
# repo's real-Postgres lane -- a required check with no local counterpart at all.
# But a gate can only run that lane against a database, and no repo documented
# how to get one: no compose file, no script, no DSN written down. The container
# that existed on the workstation had been created ad hoc in some earlier session
# and held a scatter of scratch databases. That undocumented setup WAS the
# fail-open, because a gate nobody can run is not a gate.
#
# ## Why freshness, not rebuild-every-time
#
# The expensive failure is not a slow rebuild, it is a STALE one. Measured on
# tabsii-platform while writing this: a database built about an hour earlier,
# before two PRs merged, produced **23 failures** in a module that had nothing to
# do with the change in hand. Rebuilt from the same tree it passed 336/336, and
# passed 336 again on an immediate re-run -- so the lane was genuinely
# re-runnable and every one of those failures was the old schema.
#
# That is the worst shape a local gate can have. Twenty-three red tests that are
# not your fault teach people the gate is unreliable, and an unreliable gate gets
# bypassed -- which H4 pre-registered as the condition refuting the whole
# local-gate programme. So the schema inputs are fingerprinted and a rebuild
# happens only when they actually changed: reuse ~0.3s, rebuild ~4s.
#
# ## Why it is generic
#
# It adapts to the repo rather than being told about it, for the same reason
# `verify.sh` does: forks drift, and a per-instance copy of this would drift from
# the DDL layout it is meant to build. Everything instance-specific is DERIVED --
# the schema directories from `db/imports/*/`, the engine image from whether the
# DDL asks for PostGIS, and the did-it-build threshold from the number of
# policies the DDL itself declares. Nothing here names a product.
#
# ## Usage
#
#   eval "$(sh scripts/pg-test-db.sh --export)"   # export BIFFO_TEST_PG_DSN
#   sh scripts/pg-test-db.sh                      # print the DSN on stdout
#   sh scripts/pg-test-db.sh --recreate           # force a rebuild
#
# Only the DSN reaches stdout, so it is safe to capture; progress goes to stderr.
#
# Overridable: BIFFO_PG_HOST, BIFFO_PG_PORT, BIFFO_PG_USER, BIFFO_PG_PASSWORD,
# BIFFO_PG_DB, BIFFO_PG_CONTAINER, BIFFO_PG_IMAGE.

set -eu

HOST="${BIFFO_PG_HOST:-localhost}"
PORT="${BIFFO_PG_PORT:-55432}"
USER_="${BIFFO_PG_USER:-postgres}"
PASS="${BIFFO_PG_PASSWORD:-postgres}"
DB="${BIFFO_PG_DB:-biffo_test}"
CONTAINER="${BIFFO_PG_CONTAINER:-biffo-pg-test}"

RECREATE=0
EXPORT=0
for arg in "$@"; do
  case "$arg" in
    --recreate) RECREATE=1 ;;
    --export) EXPORT=1 ;;
    -h | --help)
      sed -n '2,48p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

say() { echo "pg-test-db: $*" >&2; }

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

# --- what this repo's schema is made of --------------------------------------
#
# `db/imports/<name>/*.sql` is the Biffo DDL-import convention that the API's own
# `ddl_import.list_sql_files` reads at startup, so deriving from it means this
# script and the running app agree by construction rather than by someone
# remembering to update both.
DDL_FILES=$(find db/imports -mindepth 2 -maxdepth 2 -name '*.sql' 2>/dev/null | LC_ALL=C sort || true)
ALEMBIC_DIR=""
for _d in services/api .; do
  [ -f "$_d/alembic.ini" ] && ALEMBIC_DIR="$_d" && break
done

if [ -z "$DDL_FILES" ] && [ -z "$ALEMBIC_DIR" ]; then
  say "no db/imports/*/ DDL and no alembic.ini - this repo has no schema to build"
  exit 1
fi

# PostGIS or plain, decided by what the DDL asks for. A plain `postgres` image
# fails on the first `CREATE EXTENSION postgis`, and picking the heavier image
# unconditionally would slow every repo that does not need it.
if [ -n "$DDL_FILES" ] && echo "$DDL_FILES" | xargs grep -liE 'EXTENSION[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?postgis' >/dev/null 2>&1; then
  IMAGE="${BIFFO_PG_IMAGE:-postgis/postgis:16-3.4}"
else
  IMAGE="${BIFFO_PG_IMAGE:-postgres:16}"
fi

export PGPASSWORD="$PASS"
psql_admin() { psql -q -h "$HOST" -p "$PORT" -U "$USER_" -d postgres "$@"; }
psql_db() { psql -q -h "$HOST" -p "$PORT" -U "$USER_" -d "$DB" "$@"; }

# --- 1. a reachable server ---------------------------------------------------
#
# Started here rather than assumed, because "docker run one yourself" is exactly
# the tribal knowledge this script replaces. An already-running server is reused.
if ! psql_admin -c 'SELECT 1' >/dev/null 2>&1; then
  if ! command -v docker >/dev/null 2>&1; then
    say "no Postgres at $HOST:$PORT and docker is not installed."
    say "Start one and re-run, or set BIFFO_PG_HOST / BIFFO_PG_PORT."
    exit 1
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    say "starting existing container $CONTAINER"
    docker start "$CONTAINER" >/dev/null
  else
    say "creating container $CONTAINER ($IMAGE) on port $PORT"
    docker run -d --name "$CONTAINER" \
      -e POSTGRES_PASSWORD="$PASS" -p "$PORT:5432" "$IMAGE" >/dev/null
  fi
  # Polled, not slept: a cold image pull and a warm restart differ by an order of
  # magnitude, and one fixed sleep is wrong for both.
  _waited=0
  until psql_admin -c 'SELECT 1' >/dev/null 2>&1; do
    _waited=$((_waited + 1))
    if [ "$_waited" -gt 90 ]; then
      say "Postgres did not become ready in 90s"
      exit 1
    fi
    sleep 1
  done
  say "Postgres ready after ${_waited}s"
fi

DSN="postgresql+asyncpg://$USER_:$PASS@$HOST:$PORT/$DB"
emit() {
  if [ "$EXPORT" -eq 1 ]; then
    echo "export BIFFO_TEST_PG_DSN='$DSN'"
  else
    echo "$DSN"
  fi
}

# --- 2. is the existing schema current? --------------------------------------
#
# By CONTENT, not mtime: a branch switch changes content and leaves mtime
# anywhere. Stored inside the database, so it cannot outlive a drop or describe
# some other database.
fingerprint() {
  {
    [ -n "$ALEMBIC_DIR" ] && find "$ALEMBIC_DIR" -name '*.py' -path '*alembic*' -type f 2>/dev/null |
      LC_ALL=C sort | xargs cat 2>/dev/null
    [ -n "$DDL_FILES" ] && echo "$DDL_FILES" | xargs cat 2>/dev/null
  } | sha256sum | cut -d' ' -f1
}

WANT=$(fingerprint)
HAVE=""
if [ "$RECREATE" -eq 0 ] &&
  psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" 2>/dev/null | grep -q 1; then
  HAVE=$(psql -tAq -h "$HOST" -p "$PORT" -U "$USER_" -d "$DB" \
    -c "SELECT value FROM biffo_pg_test_fingerprint LIMIT 1" 2>/dev/null || true)
fi

if [ -n "$HAVE" ] && [ "$HAVE" = "$WANT" ]; then
  say "schema is current, reusing $DB"
  emit
  exit 0
fi

[ -n "$HAVE" ] && say "schema inputs changed - rebuilding rather than serving a stale schema"

# --- 3. rebuild the way the app and CI do ------------------------------------
say "rebuilding $DB"
psql_admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null
psql_admin -c "CREATE DATABASE $DB" >/dev/null

if [ -n "$ALEMBIC_DIR" ]; then
  BIFFO_DATABASE_URL="$DSN" uv run --directory "$ALEMBIC_DIR" alembic upgrade head >/dev/null
  say "alembic upgrade head"
fi

if [ -n "$DDL_FILES" ]; then
  # ONE psql session, sorted by filename, mirroring the API's own DDL import.
  # Session state an early module sets -- typically `SET search_path` in the
  # first file -- has to survive into later ones, so a per-file connection would
  # silently change the meaning of every unqualified name after it. LC_ALL=C
  # keeps the shell's sort byte-ordered to match Python's.
  # shellcheck disable=SC2046
  psql -q -v ON_ERROR_STOP=1 -h "$HOST" -p "$PORT" -U "$USER_" -d "$DB" \
    --single-transaction $(echo "$DDL_FILES" | sed 's/^/-f /' | tr '\n' ' ') >/dev/null
  say "$(echo "$DDL_FILES" | wc -l | tr -d ' ') DDL modules applied"
fi

# --- 4. refuse to bless a half-built schema ----------------------------------
#
# The threshold is derived, not guessed: count the policies the DDL declares and
# require the database to hold at least half. Recording a fingerprint against a
# partial schema is worse than failing, because the NEXT run would trust it and
# every failure after that would look like the developer's own change.
if [ -n "$DDL_FILES" ]; then
  _declared=$(echo "$DDL_FILES" | xargs grep -ciE '^[[:space:]]*CREATE[[:space:]]+POLICY' 2>/dev/null |
    awk -F: '{s+=$NF} END {print s+0}')
  if [ "${_declared:-0}" -gt 0 ]; then
    _actual=$(psql -tAq -h "$HOST" -p "$PORT" -U "$USER_" -d "$DB" \
      -c "SELECT count(*) FROM pg_policies" 2>/dev/null || echo 0)
    if [ "${_actual:-0}" -lt $((_declared / 2)) ]; then
      say "only ${_actual:-0} policies present against $_declared declared - the schema did not build."
      say "Not recording a fingerprint; fix the DDL and re-run."
      exit 1
    fi
    say "$_actual RLS policies ($_declared declared)"
  fi
fi

psql_db \
  -c "CREATE TABLE IF NOT EXISTS biffo_pg_test_fingerprint (value text primary key)" \
  -c "TRUNCATE biffo_pg_test_fingerprint" \
  -c "INSERT INTO biffo_pg_test_fingerprint (value) VALUES ('$WANT')" >/dev/null

say "ready"
emit
