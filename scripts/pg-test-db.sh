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
#   eval "$(sh scripts/pg-test-db.sh --export)"   # export BIFFO_TEST_PG_DSN and TABSII_TEST_PG_DSN
#   sh scripts/pg-test-db.sh                      # print the DSN on stdout
#   sh scripts/pg-test-db.sh --recreate           # force a rebuild
#
# Only the DSN reaches stdout, so it is safe to capture; progress goes to stderr.
#
# `--export` sets BOTH `BIFFO_TEST_PG_DSN` and `TABSII_TEST_PG_DSN` (see
# tabsii-platform#755): every consumer this script has ever had reads one name
# or the other, `scripts/verify.sh`'s own bridge already treats them as
# interchangeable, and a script that only ever emits one of the two names it
# claims to serve is exactly the fail-open this file's own docstring above
# argues against -- a gate nobody can run, just one name late instead of a
# missing script. Emitting both means the name a consumer happens to read is no
# longer load-bearing.
#
# Overridable: BIFFO_PG_HOST, BIFFO_PG_PORT, BIFFO_PG_USER, BIFFO_PG_PASSWORD,
# BIFFO_PG_DB, BIFFO_PG_CONTAINER, BIFFO_PG_IMAGE.
#
# ## Concurrency: derived, not coordinated
#
# The port, database name, and container name below default to values DERIVED
# from this checkout's own path, not fixed constants. A fixed port
# (`BIFFO_PG_PORT` used to default to `55432` everywhere) meant any two
# checkouts running this script at the same time -- two worktrees of one repo,
# or two entirely different repos on one machine -- attached to the SAME
# Postgres cluster and raced on cluster-wide catalogs like `pg_shdepend`
# (#1114). A fixed database name (`biffo_test`) meant they then shared one
# database on top of that (#1120).
#
# The fix is not a lock: a machine-wide `flock` around this script would make
# concurrent runs correct by serializing them, but that is coordination, and
# this estate's shared-mutable-state defects have twice been solved instead by
# making the value itself unique per user rather than making users take turns.
# Deriving from `$REPO_ROOT` gets that for free -- it is already different for
# every worktree and every repo -- and deterministically, so repeat runs
# against the SAME checkout still land on the same port/db/container and reuse
# the fingerprinted schema (see step 2 below) instead of rebuilding it under a
# fresh identity every time. `BIFFO_PG_PORT`, `BIFFO_PG_DB`, and
# `BIFFO_PG_CONTAINER` remain explicit overrides; only the *default* changed.

set -eu

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

# sha256sum is already a dependency of this script (see `fingerprint` below),
# so reusing it here for a deterministic, cheap per-checkout key adds nothing
# new to install. 12 hex chars is ample to keep collisions between checkouts
# on one machine practically impossible while staying short enough to read in
# `docker ps` output and a psql prompt.
_checkout_key=$(printf '%s' "$REPO_ROOT" | sha256sum | cut -c1-12)
_checkout_suffix=$(printf '%s' "$_checkout_key" | cut -c1-8)
# IANA's dynamic/private port range (49152-65535, 16384 ports) mapped from the
# next 4 hex chars of the same hash -- an ephemeral port picked deterministically
# rather than asked of the OS, because a freshly-random port on every invocation
# would break the reuse this key is for (a second run against the same checkout
# has to land back on the same container to find its existing database).
_checkout_port=$((49152 + (0x$(printf '%s' "$_checkout_key" | cut -c9-12) % 16384)))

HOST="${BIFFO_PG_HOST:-localhost}"
PORT="${BIFFO_PG_PORT:-$_checkout_port}"
USER_="${BIFFO_PG_USER:-postgres}"
PASS="${BIFFO_PG_PASSWORD:-postgres}"
DB="${BIFFO_PG_DB:-biffo_test_$_checkout_suffix}"
# Keyed the same way as PORT and for the same reason: the container is where
# the port mapping actually lives (`docker run -p "$PORT:5432"`), so if the
# container name stayed fixed while the port became per-checkout, a second
# checkout would find the first checkout's container already occupying that
# name, "start" it rather than create its own, and then poll forever against a
# port that container was never bound to.
CONTAINER="${BIFFO_PG_CONTAINER:-biffo-pg-test-$_checkout_suffix}"

RECREATE=0
EXPORT=0
for arg in "$@"; do
  case "$arg" in
    --recreate) RECREATE=1 ;;
    --export) EXPORT=1 ;;
    -h | --help)
      sed -n '2,72p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

say() { echo "pg-test-db: $*" >&2; }

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
# ── Reap abandoned sibling containers ────────────────────────────────────────
#
# The container name is keyed to the CHECKOUT (see `CONTAINER` above), which is
# what makes reuse work -- and also what makes them accumulate: every worktree
# ever created leaves one behind, running, forever. Nothing ever removed them.
# Measured on one workstation: 76 live `biffo-pg-test-*` containers holding
# ~5.4 GiB, the oldest four days old (tabsii-platform#703). That is not merely
# untidy -- they compete for the same page cache and I/O as the lane being
# timed, so a leak like this shows up as the pg gate drifting toward its own
# timeout, which is the failure #703 was actually filed about.
#
# Age is the only signal available. Docker records when a container was CREATED,
# not when it was last used, and `docker ps --filter until=` is a prune filter
# that this daemon rejects on `ps` -- so the comparison is done here.
#
# Reaping something still wanted is cheap and self-correcting: the next run
# recreates it, which this script's own header prices at ~4s against ~0.3s for
# reuse. Being wrong therefore costs four seconds, once. Leaving them costs a
# gigabyte a day.
#
# NEVER reaps this checkout's own container, is skipped entirely when the date
# maths is unavailable rather than guessing, and never fails the run: a
# housekeeping step that can break a test lane is worse than the mess it clears.
BIFFO_PG_REAP_HOURS="${BIFFO_PG_REAP_HOURS:-24}"
if [ "$BIFFO_PG_REAP_HOURS" -gt 0 ] 2>/dev/null && command -v docker >/dev/null 2>&1; then
  # GNU first, then BSD/macOS. If neither answers, say so and skip -- a silent
  # skip here would be the same fail-open this estate keeps finding.
  _reap_cutoff=$(date -u -d "-${BIFFO_PG_REAP_HOURS} hours" +%Y-%m-%dT%H:%M:%S 2>/dev/null) ||
    _reap_cutoff=$(date -u -v-"${BIFFO_PG_REAP_HOURS}"H +%Y-%m-%dT%H:%M:%S 2>/dev/null) || _reap_cutoff=""
  if [ -z "$_reap_cutoff" ]; then
    say "cannot compute a reap cutoff on this date(1); skipping container reaping"
  else
    _reaped=0
    for _c in $(docker ps -a --filter "name=biffo-pg-test-" --format '{{.Names}}' 2>/dev/null); do
      [ "$_c" = "$CONTAINER" ] && continue
      _made=$(docker inspect -f '{{.Created}}' "$_c" 2>/dev/null | cut -c1-19)
      [ -z "$_made" ] && continue
      # Both are UTC ISO-8601 to the second, so a string compare IS a time
      # compare -- no epoch conversion, and portable across date(1) flavours.
      if awk -v a="$_made" -v b="$_reap_cutoff" 'BEGIN { exit !(a < b) }'; then
        docker rm -f "$_c" >/dev/null 2>&1 && _reaped=$((_reaped + 1))
      fi
    done
    [ "$_reaped" -gt 0 ] &&
      say "reaped $_reaped container(s) unused for over ${BIFFO_PG_REAP_HOURS}h (set BIFFO_PG_REAP_HOURS=0 to disable)"
  fi
fi

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
    # Both names, deliberately (tabsii-platform#755): whichever a consumer
    # reads, an `eval` of this line alone is enough -- see the Usage note above.
    echo "export BIFFO_TEST_PG_DSN='$DSN'"
    echo "export TABSII_TEST_PG_DSN='$DSN'"
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
