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
#
# ## The case that key does NOT cover: two runs from ONE checkout
#
# Deriving from `$REPO_ROOT` isolates two *checkouts*. It cannot isolate two
# *runs of the same checkout*, because it is deterministic on purpose -- that
# determinism is what makes reuse work. So a developer running the suite while
# `git push` fires the pre-push gate gets two concurrent sessions against ONE
# database, and neither is doing anything wrong: the gate is automatic, and the
# developer never chose to run two things at once.
#
# What that costs is not a lost race, it is a MISATTRIBUTED one. Measured on
# 2026-08-09: a push gate reported `test_lead_unsubscribe_pg.py` failing with a
# foreign-key violation, in a file the change under test never touched, while a
# full suite from the same worktree was concurrently deleting and re-seeding the
# rows it depends on. The gate was believed, the change was suspected, and the
# database had to be recreated before the red would clear.
#
# Per-test-file tenant namespaces (see `setup_pg`'s advisory-lock note) make ONE
# run internally parallel-safe. They do nothing here, because the colliding
# writers are the SAME file run twice.
#
# ## The fix, and why it is a clone rather than a lock
#
# The fingerprinted database is now a TEMPLATE, never handed out. Each run gets
# its own `..._r<key>` clone via `CREATE DATABASE ... TEMPLATE`, and the DSN
# points at that.
#
# This keeps the principle the port/name key already established -- make the
# value unique rather than make users take turns -- and it is affordable because
# a template clone is a file copy the server does itself: **0.10s for a 25 MB
# schema**, measured on the tabsii-platform lane, against the ~0.3s reuse path
# this script already advertises as fast. A `flock` would instead have cost the
# pushing developer the full runtime of whatever else was running.
#
# `BIFFO_PG_SHARED=1` opts out and returns the template directly, for the case
# that genuinely wants a stable name across invocations -- attaching a psql
# session to inspect what a failing run left behind.

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
# The TEMPLATE: fingerprinted, rebuilt only when the schema inputs change, and
# never handed to a caller unless sharing is requested. An explicit BIFFO_PG_DB
# still names it, so that override keeps meaning what it always did.
DB="${BIFFO_PG_DB:-biffo_test_$_checkout_suffix}"

# Opt out of per-run cloning (see the concurrency note above). Naming a database
# explicitly implies it: BIFFO_PG_DB is a request for THAT database.
SHARED="${BIFFO_PG_SHARED:-0}"
[ -n "${BIFFO_PG_DB:-}" ] && SHARED=1

# Minutes an abandoned clone survives before a later run reaps it. Generous on
# purpose: a clone with no connections may simply be between `--export` and the
# first test connecting, and dropping one out from under a caller is a worse
# failure than leaving a few megabytes on disk.
CLONE_TTL_MIN="${BIFFO_PG_CLONE_TTL_MIN:-240}"
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
    _considered=0
    # TWO filters, not one literal name (#1383). The label is what containers
    # created from here now carry; the name prefix keeps covering every one
    # created before the label existed, which is all of them on any workstation
    # that has run this before. `sort -u` because a container matching both
    # filters is listed by both.
    _reapable=$(
      {
        docker ps -a --filter "name=biffo-pg-test-" --format '{{.Names}}' 2>/dev/null
        docker ps -a --filter "label=biffo.ephemeral=1" --format '{{.Names}}' 2>/dev/null
      } | sort -u
    )
    # A space-separated copy, purely for the `case` membership test below. The
    # newline-separated form cannot be tested with *" $_c "* -- the separator is
    # a newline, so only the first and last entries would ever match, and every
    # container this script owns would be re-reported as one it does not.
    _reapable_flat=" $(printf '%s ' $_reapable)"
    for _c in $_reapable; do
      [ "$_c" = "$CONTAINER" ] && continue
      _made=$(docker inspect -f '{{.Created}}' "$_c" 2>/dev/null | cut -c1-19)
      [ -z "$_made" ] && continue
      _considered=$((_considered + 1))
      # Both are UTC ISO-8601 to the second, so a string compare IS a time
      # compare -- no epoch conversion, and portable across date(1) flavours.
      if awk -v a="$_made" -v b="$_reap_cutoff" 'BEGIN { exit !(a < b) }'; then
        docker rm -f "$_c" >/dev/null 2>&1 && _reaped=$((_reaped + 1))
      fi
    done
    [ "$_reaped" -gt 0 ] &&
      say "reaped $_reaped of $_considered container(s) unused for over ${BIFFO_PG_REAP_HOURS}h (set BIFFO_PG_REAP_HOURS=0 to disable)"

    # ── What the reaper can SEE but must not touch ──────────────────────────
    #
    # The defect in #1383 was not that stale containers survived; it was that
    # they were outside the denominator, so a clean reaper run was a true
    # statement about a set that silently excluded them. Three Postgres
    # containers up for DAYS -- one of them six -- sat beside a perfectly tidy
    # `biffo-pg-test-*` family, and a `tabsii-rls-local` two days stale is
    # already measured in docs/guides/development-practices.md as costing ~20m
    # of chasing failures that belonged to nobody.
    #
    # They are REPORTED, never removed, and that is a deliberate departure from
    # the issue's preferred fix ("reap any container on the Postgres test image
    # with no client connections"). The reaper's own licence to delete rests on
    # "reaping something still wanted is cheap and self-correcting" -- true only
    # of containers THIS script creates, because this script recreates them. A
    # hand-run container may hold hand-loaded data that nothing here can
    # reconstruct, and an idle one is exactly the case a connection check
    # cannot distinguish from an abandoned one. Widening the deletion set to
    # every `postgres:`/`postgis:` image would trade an invisible mess for an
    # unrecoverable one.
    #
    # So: name them, price them, and let a human decide. That is what would have
    # made this visible six days earlier instead of during an unrelated cleanup.
    # One `docker ps` for names AND images, so the image filter costs nothing;
    # only the handful that survive it are worth an `inspect` for the timestamp.
    # This runs on every pg-lane invocation, so a per-container inspect over the
    # whole daemon would put ~1s on a hot path to print a housekeeping note.
    # Neither field can contain a space, so a space separator needs no IFS
    # games -- and `IFS=$'\t'` would not have worked anyway: these scripts run
    # under dash, where that splits on the four characters $ ' \ t.
    _unclaimed=''
    docker ps -a --format '{{.Names}} {{.Image}}' 2>/dev/null | {
      while read -r _c _img; do
        [ "$_c" = "$CONTAINER" ] && continue
        case "$_reapable_flat" in *" $_c "*) continue ;; esac
        # Both images this script can choose (see IMAGE above), matched by
        # repository rather than tag so a BIFFO_PG_IMAGE override still lands.
        case "$_img" in postgres:* | postgis/*) ;; *) continue ;; esac
        _made=$(docker inspect -f '{{.Created}}' "$_c" 2>/dev/null | cut -c1-19)
        [ -z "$_made" ] && continue
        awk -v a="$_made" -v b="$_reap_cutoff" 'BEGIN { exit !(a < b) }' &&
          _unclaimed="$_unclaimed $_c($_img)"
      done
      # Reported inside the subshell the pipeline created: `_unclaimed` set in a
      # piped `while` does not survive it in a POSIX shell.
      if [ -n "$_unclaimed" ]; then
        say "NOT reaped -- Postgres containers over ${BIFFO_PG_REAP_HOURS}h old that this script did not create:"
        for _u in $_unclaimed; do say "  $_u"; done
        say "  A stale one costs test failures that belong to nobody (#1383). Remove by hand"
        say "  (docker rm -f <name>), or start it with --label biffo.ephemeral=1 to have it reaped."
      fi
    }
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
    # The label is what makes this container reapable by a property rather than
    # by the name it happens to carry (#1383). The name prefix still works and
    # is still scanned, but it only ever described containers this script named;
    # anything started under another name was outside the reaper's denominator
    # entirely. A label travels with the container whatever it is called.
    docker run -d --name "$CONTAINER" --label biffo.ephemeral=1 \
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

# What the caller is handed. Rewritten to a per-run clone below unless sharing
# was requested; `DSN` keeps naming the template, because that is what the
# alembic/DDL build steps must connect to.
RUN_DB="$DB"
RUN_DSN="$DSN"

# ── Per-run clone ────────────────────────────────────────────────────────────
#
# Called after the template is known-good, so a clone can never predate the
# schema it is supposed to carry.
clone_for_this_run() {
  [ "$SHARED" -eq 1 ] && {
    say "BIFFO_PG_SHARED - using the template $DB directly, NOT isolated from a concurrent run"
    return 0
  }

  # Reap first, so a long-lived checkout does not accumulate clones forever.
  # Only ones with no backends AND older than the TTL: `datconnlimit`-style
  # liveness alone would drop a clone in the gap between `--export` and the
  # first test connecting.
  # Both ways this query can fail degrade to NOT reaping, which is the safe
  # direction — it leaks disk rather than dropping a database out from under a
  # live caller. `pg_stat_file` needs superuser (or pg_read_server_files), which
  # the container has and a managed server may not; and a database in a custom
  # tablespace is not under `base/`, so the file is missing and `missing_ok`
  # returns NULL, which COALESCE turns into "not old enough".
  _stale=$(psql_admin -tAc "
    SELECT d.datname
      FROM pg_database d
     WHERE d.datname LIKE '${DB}_r%'
       AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)
       AND COALESCE((pg_stat_file('base/' || d.oid || '/PG_VERSION', true)).modification,
                    now()) < now() - interval '$CLONE_TTL_MIN minutes'
  " 2>/dev/null || true)
  for _old in $_stale; do
    psql_admin -c "DROP DATABASE IF EXISTS \"$_old\" WITH (FORCE)" >/dev/null 2>&1 || true
    say "reaped abandoned clone $_old"
  done

  # $$ is this shell; the seconds make a second run in the same second (or a
  # recycled pid) distinct. Short enough to read in a psql prompt.
  _run_key=$(printf '%s%s' "$$" "$(date +%s)" | sha256sum | cut -c1-8)
  RUN_DB="${DB}_r${_run_key}"

  # WITH (FORCE) so a previous clone under the same name (only possible if the
  # key collided) cannot wedge this run behind someone else's idle session.
  psql_admin -c "DROP DATABASE IF EXISTS \"$RUN_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
  if ! psql_admin -c "CREATE DATABASE \"$RUN_DB\" TEMPLATE \"$DB\"" >/dev/null 2>&1; then
    # The one failure mode worth naming: CREATE DATABASE ... TEMPLATE refuses
    # while any session is connected to the template. That means something is
    # using the template directly -- almost always a psql attached by hand, or a
    # run started before this change with an exported DSN.
    say "could not clone $DB - is something still connected to it?"
    psql_admin -tAc "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = '$DB'" 2>/dev/null |
      while read -r _u; do [ -n "$_u" ] && say "  template in use by: $_u"; done
    say "disconnect it, or set BIFFO_PG_SHARED=1 to use the template directly"
    exit 1
  fi
  RUN_DSN="postgresql+asyncpg://$USER_:$PASS@$HOST:$PORT/$RUN_DB"
  say "cloned $DB -> $RUN_DB (isolated from any concurrent run)"
}
emit() {
  if [ "$EXPORT" -eq 1 ]; then
    # Both names, deliberately (tabsii-platform#755): whichever a consumer
    # reads, an `eval` of this line alone is enough -- see the Usage note above.
    echo "export BIFFO_TEST_PG_DSN='$RUN_DSN'"
    echo "export TABSII_TEST_PG_DSN='$RUN_DSN'"
  else
    echo "$RUN_DSN"
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
  clone_for_this_run
  emit
  exit 0
fi

[ -n "$HAVE" ] && say "schema inputs changed - rebuilding rather than serving a stale schema"

# --- 3. rebuild the way the app and CI do ------------------------------------
say "rebuilding $DB"
# Every existing clone carries the OLD schema, so they are stale by definition
# the moment the template is rebuilt. Dropping them here is also what makes
# `CREATE DATABASE ... TEMPLATE` possible afterwards without waiting out the TTL.
for _c in $(psql_admin -tAc "SELECT datname FROM pg_database WHERE datname LIKE '${DB}_r%'" 2>/dev/null || true); do
  psql_admin -c "DROP DATABASE IF EXISTS \"$_c\" WITH (FORCE)" >/dev/null 2>&1 || true
  say "dropped clone $_c of the previous schema"
done
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

# Only now, with the fingerprint recorded against a schema that passed the
# check above, is the template fit to copy. Cloning earlier would hand out a
# half-built database and record the failure against whoever ran next.
clone_for_this_run

say "ready"
emit
