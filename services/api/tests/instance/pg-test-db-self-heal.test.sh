#!/bin/sh
# Timeout path of scripts/pg-test-db.sh: a pre-existing container that never
# becomes ready is logged, removed (-v) and recreated once; a second failure
# fails with the new container's logs. Fake docker/psql; nothing real is touched.
set -u
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
cat >"$T/bin/docker" <<'EOF'
#!/bin/sh
echo "docker $*" >>"$T/calls"
case "$1" in
  ps) [ -f "$T/exists" ] && echo "$BIFFO_PG_CONTAINER"; exit 0 ;;
  rm) rm -f "$T/exists"; touch "$T/removed"; exit 0 ;;
  run) touch "$T/exists"; [ "$FRESH_OK" = 1 ] && touch "$T/ready"; exit 0 ;;
  logs) echo "FAKE-LOGS"; exit 0 ;;
  *) exit 0 ;;
esac
EOF
cat >"$T/bin/psql" <<'EOF'
#!/bin/sh
[ -f "$T/ready" ] || exit 2
exit 0
EOF
chmod +x "$T/bin/docker" "$T/bin/psql"
fail=0
run() { # $1 = FRESH_OK
  rm -f "$T/calls" "$T/removed" "$T/ready"; touch "$T/exists"
  T=$T FRESH_OK=$1 PATH="$T/bin:$PATH" BIFFO_PG_CONTAINER=biffo-pg-test-selfheal \
    BIFFO_PG_READY_SECS=1 BIFFO_PG_REAP_HOURS=0 BIFFO_PG_PORT=59999 \
    sh "$ROOT/scripts/pg-test-db.sh" --export >"$T/out" 2>&1
}
check() { grep -q -- "$1" "$2" || { echo "FAIL: missing '$1' in $3"; fail=1; }; }

run 0
check "docker rm -f -v biffo-pg-test-selfheal" "$T/calls" "calls(stuck)"
check "docker run -d --name biffo-pg-test-selfheal --label biffo.ephemeral=1" "$T/calls" "calls(stuck)"
check "FAKE-LOGS" "$T/out" "output(stuck)"
check "also failed" "$T/out" "output(stuck)"
[ "$(grep -c '^docker run' "$T/calls")" = 1 ] || { echo "FAIL: recreate not exactly once"; fail=1; }

run 1
check "docker rm -f -v" "$T/calls" "calls(heal)"
check "Postgres ready" "$T/out" "output(heal)"
grep -q "also failed" "$T/out" && { echo "FAIL: healed run reported failure"; fail=1; }

[ "$fail" = 0 ] && echo "pg-test-db-self-heal: ok"
exit "$fail"
