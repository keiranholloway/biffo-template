#!/usr/bin/env sh
#
# Allocate the next free DDL module number for db/imports/<name>/ --
# atomically, across every concurrently running branch (issue #1886).
#
# ## The defect this replaces
#
# `db/imports/<instance>/NNN_name.sql` numbers have always been picked by
# `ls db/imports/<instance>/ | tail`: read the directory, add one, name the
# file. That "read, then decide" has no coordination across branches, so two
# sessions that read the same directory listing before either commits both
# compute the identical "next" number -- confirmed live twice in
# tabsii-platform (module 183 vs 184, and again in #1176's own delivery,
# PR#1292's `182`). `tabsii-platform#799`'s guard
# (`test_no_new_duplicate_module_numbers_against_current_dev`) catches the
# collision at MERGE time, which is necessarily after both branches already
# exist -- a detector, not a preventer. This script is the preventer: it
# removes the race instead of catching it after the fact, and #799's guard
# stays in place as the backstop for anything that still slips through (a
# hand-authored file that never went through this allocator, for instance).
#
# ## Why this is race-free, not merely dressed up the same way
#
# A "locked sequence file" or a plain `git push` of a candidate number is
# still "read, then decide, then write" with a gap in between -- the gap is
# just narrower. This script instead makes the DECISION itself an atomic
# operation on the remote: it reserves a number by creating a git ref,
#
#   refs/biffo-module-locks/<name>/<NNN>
#
# via `git push <remote> <sha>:<ref> --force-with-lease="<ref>:"`. The empty
# expected-value after the second `:` tells git "only accept this push if
# the ref does not already exist on the remote" -- a real compare-and-swap
# on the ref's existence, enforced by the remote's own ref store, not by
# anything this script (or the machine it runs on) controls. Two processes
# racing to create the SAME ref name can never both win: exactly one push
# succeeds and every other gets "reference already exists" (or "stale
# info", depending on timing) and retries against the now-current state.
# Verified directly against a real git remote (a local bare repository, no
# mocking) by racing six concurrent pushes for one ref name: exactly one
# won every time -- see scripts/allocate-module-number.test.sh.
#
# This is the SAME primitive GitHub's own branch/tag creation relies on
# (git's ref update is a single compare-and-swap in the remote's ref
# store), so it works identically against a real GitHub remote and against
# a throwaway local bare repo in tests -- the mechanism under test is the
# real one, not a stand-in for it.
#
# A plain (non-lease) `git push <sha>:<ref>` is NOT equivalent and was
# rejected during design: git allows a fast-forward UPDATE of an existing
# ref without `--force`, so two racers whose commits happen to share
# ancestry can both "succeed" against the same ref name (verified: pushing
# a descendant commit onto an already-created ref reports `[new
# branch]`-style success, not a rejection). `--force-with-lease="<ref>:"`
# is what turns this into a strict CREATE-ONLY operation.
#
# ## What is NOT solved, by design
#
# - A number that is reserved but never used (the agent abandons the branch
#   before creating the file) burns that number permanently -- there is no
#   "release". This mirrors GitHub issue/PR numbers and this very chain's
#   own existing gaps (module 182 in tabsii-platform, retired during the
#   #1293 collision fix) and is an acceptable trade-off: a permanent gap
#   costs nothing, a reused number costs a checksum-locked, un-fixable
#   collision.
# - This only prevents a NEW collision going forward. It does not, and
#   cannot, retroactively fix already-duplicated numbers on `dev` --
#   `GRANDFATHERED_DUPLICATE_MODULE_NUMBERS` in each instance's own
#   `test_ddl_import_conventions.py` still owns that residue.
# - Each instance's own merge-time guard (tabsii-platform#799) stays as the
#   backstop for anything that reaches `dev` without ever calling this
#   script (a hand-authored file, a script bypass) -- this removes the RACE,
#   it does not remove the need to keep checking.
#
# ## Usage
#
#   sh scripts/allocate-module-number.sh <import-dir-name> [options]
#
# See `usage()` below for options. Prints the allocated number (e.g. "191")
# to stdout on success and nothing else -- every other message goes to
# stderr, so `NUM=$(sh scripts/allocate-module-number.sh tabsii)` is safe to
# script against.
#
# Exit codes follow the estate's three-valued convention (never a two-valued
# pass/fail): 0 allocated, 1 bad usage / cannot even attempt, 2 could not
# CONFIRM an allocation -- never treat 2 as "no number needed" or "pick one
# yourself".

set -eu

SELF_NAME="allocate-module-number.sh"
LOCK_PREFIX="refs/biffo-module-locks"

MAX_ATTEMPTS=${BIFFO_ALLOC_MAX_ATTEMPTS:-30}
RETRY_SLEEP_SECONDS=${BIFFO_ALLOC_RETRY_SLEEP:-1}
GIT_REMOTE="origin"
BASE_BRANCH="dev"
IMPORT_NAME=""

usage() {
  cat <<'EOF'
Usage: sh scripts/allocate-module-number.sh <import-dir-name> [options]

Atomically allocates the next free NNN module number for
db/imports/<import-dir-name>/, coordinating across every concurrently
running branch via an exclusive git ref reservation on the remote -- never
by reading a local directory listing.

  <import-dir-name>   the db/imports/ subdirectory, e.g. "tabsii". May be
                       omitted when db/imports/ has exactly one subdirectory.

Options:
  -R owner/repo         target a specific GitHub repo over HTTPS (mirrors
                         scripts/claim.sh's -R)
  --git-remote <value>  the git remote name or URL to reserve against
                         (default: origin). Overrides -R if both are given --
                         this is how scripts/allocate-module-number.test.sh
                         points the allocator at a throwaway local bare repo
                         instead of a real GitHub remote.
  --base <branch>       the integration branch to read existing module
                         numbers from (default: dev)
  -h, --help            show this help

Prints the allocated number to stdout on success. Nothing else goes to
stdout, so `NUM=$(sh scripts/allocate-module-number.sh tabsii)` is safe.

Exit codes: 0 allocated, 1 bad usage, 2 could not confirm an allocation
(NEVER a pass -- do not treat this as "no number available").
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -R)
      shift
      [ $# -gt 0 ] || { echo "$SELF_NAME: -R requires owner/repo" >&2; exit 1; }
      GIT_REMOTE="https://github.com/$1.git"
      shift
      ;;
    --git-remote)
      shift
      [ $# -gt 0 ] || { echo "$SELF_NAME: --git-remote requires a value" >&2; exit 1; }
      GIT_REMOTE="$1"
      shift
      ;;
    --base)
      shift
      [ $# -gt 0 ] || { echo "$SELF_NAME: --base requires a branch name" >&2; exit 1; }
      BASE_BRANCH="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "$SELF_NAME: unrecognized option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$IMPORT_NAME" ]; then
        echo "$SELF_NAME: unexpected extra argument: $1" >&2
        exit 1
      fi
      IMPORT_NAME="$1"
      shift
      ;;
  esac
done

if [ -z "$IMPORT_NAME" ] && [ -d db/imports ]; then
  # Auto-detect only when unambiguous: exactly one subdirectory.
  _count=$(find db/imports -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  if [ "$_count" = "1" ]; then
    IMPORT_NAME=$(find db/imports -mindepth 1 -maxdepth 1 -type d -exec basename {} \;)
  fi
fi

if [ -z "$IMPORT_NAME" ]; then
  echo "$SELF_NAME: no <import-dir-name> given and db/imports/ does not have exactly one subdirectory -- pass it explicitly." >&2
  usage >&2
  exit 1
fi

case "$IMPORT_NAME" in
  */*|*'..'*)
    echo "$SELF_NAME: invalid import dir name: $IMPORT_NAME" >&2
    exit 1
    ;;
esac

git rev-parse HEAD >/dev/null 2>&1 || {
  echo "$SELF_NAME: could not resolve HEAD -- run this from inside a git worktree with at least one commit." >&2
  exit 1
}

# The value pushed to claim a candidate ref is a fresh, unique commit object
# -- deliberately NOT this worktree's own HEAD. Two racers sharing an
# identical HEAD (routine: two worktrees freshly branched from the same
# origin/dev tip, calling this script before either has committed anything
# of its own) would otherwise push the IDENTICAL sha, and git treats "the
# remote ref already holds exactly this value" as a no-op SUCCESS rather
# than evaluating the create-only lease at all -- so BOTH racers would read
# back "allocated", handing out the same number twice. Caught by this
# script's own concurrency test (scripts/allocate-module-number.test.sh)
# racing real, identical worktree HEADs, which reproduced exactly that
# duplicate before this fix. The commit needs no parent and no real tree
# content -- it exists only to have a sha nothing else on earth also has --
# so it points at the empty tree and is never checked out or reachable from
# any branch.
_empty_tree=$(git hash-object -w -t tree /dev/null)
_entropy=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n') || _entropy=""
# Explicit identity env vars rather than relying on user.name/user.email
# being configured -- this may be the first git-writing operation in a
# fresh CI checkout or a worktree nobody has set identity in yet, and the
# lock object's "author" means nothing (it is never displayed or blamed).
LOCK_SHA=$(
  GIT_AUTHOR_NAME="biffo-module-lock" GIT_AUTHOR_EMAIL="biffo-module-lock@invalid" \
  GIT_COMMITTER_NAME="biffo-module-lock" GIT_COMMITTER_EMAIL="biffo-module-lock@invalid" \
  git commit-tree "$_empty_tree" -m "biffo module-lock claim $$ $(date +%s%N 2>/dev/null || date +%s) ${_entropy:-noentropy}"
)

# A scratch local ref, PID-qualified, to hold the fetched base branch tip.
# Deliberately NOT the ordinary remote-tracking ref (refs/remotes/<remote>/<base>)
# and NOT FETCH_HEAD: both are shared, mutable state across every worktree of
# THIS clone (worktrees share one .git). Two of this script's own invocations
# racing in two different worktrees of the same clone would otherwise be able
# to stomp each other's read of "what dev currently contains" between the
# fetch and the read -- a local race this script must not reintroduce while
# removing the cross-machine one. $$ (this process's PID) is unique among
# concurrently running processes on one machine, so this name cannot collide
# with a concurrent sibling invocation; cleaned up unconditionally on exit.
SCRATCH_REF="refs/biffo-scratch/alloc-$$"
cleanup() {
  git update-ref -d "$SCRATCH_REF" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if ! git fetch --quiet "$GIT_REMOTE" "$BASE_BRANCH:$SCRATCH_REF"; then
  echo "$SELF_NAME: could not fetch '$BASE_BRANCH' from '$GIT_REMOTE' -- cannot verify existing module numbers, refusing to guess a next one." >&2
  exit 2
fi

# db/imports/<name>/NNN_*.sql numbers already on the base branch, as of the
# fetch just above. This is the day-one baseline; going forward every number
# also gets a lock ref (below), which is what actually prevents a collision.
base_numbers() {
  git ls-tree -r --name-only "$SCRATCH_REF" -- "db/imports/$IMPORT_NAME/" 2>/dev/null |
    awk -F'/' '{n=$NF; sub(/_.*/, "", n); print n}' |
    grep -E '^[0-9]+$' || true
}

# Numbers already claimed in THIS worktree, on disk, that may not be pushed
# or merged yet -- checked fresh each attempt in case this same session adds
# a file mid-loop.
local_numbers() {
  if [ -d "db/imports/$IMPORT_NAME" ]; then
    find "db/imports/$IMPORT_NAME" -maxdepth 1 -type f -name '*.sql' 2>/dev/null |
      awk -F'/' '{n=$NF; sub(/_.*/, "", n); print n}' |
      grep -E '^[0-9]+$' || true
  fi
}

# Numbers reserved by ANY branch via this same mechanism, whether or not a
# file has been created for them yet -- read fresh on every attempt, because
# this is the set that actually changes while we retry.
lock_numbers() {
  git ls-remote "$GIT_REMOTE" "${LOCK_PREFIX}/${IMPORT_NAME}/*" 2>/dev/null |
    awk -F'/' '{print $NF}'
}

# One past the highest known number, preserving zero-padding width (mirrors
# tabsii-platform's own `_next_free_number`: `["010","011","029"]` -> `030`;
# `["099"]` -> `100`; empty -> `001`). This is a LIVENESS optimisation only --
# picking a bad candidate here costs a retry, never a collision, because the
# lease-guarded push below is the only thing that actually decides.
next_free_number() {
  awk '
    { n = $0
      if (n == "") next
      len = length(n)
      if (len > width) width = len
      val = n + 0
      if (val > max) max = val
      found = 1
    }
    END {
      if (width < 3) width = 3
      if (!found) { printf "%0*d\n", width, 1; exit }
      printf "%0*d\n", width, max + 1
    }'
}

_base_numbers=$(base_numbers)

attempt=1
allocated=""
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  known=$(
    printf '%s\n' "$_base_numbers"
    local_numbers
    lock_numbers
  )
  candidate=$(printf '%s\n' "$known" | next_free_number)
  ref="${LOCK_PREFIX}/${IMPORT_NAME}/${candidate}"

  # --no-verify: this pushes a marker commit to a coordination ref, not a
  # code change, so it must not trigger this clone's shared client-side
  # pre-push hook (.githooks/pre-push -- shared across every worktree of
  # this clone, and unconditionally runs the FULL local gate, `biffo
  # verify`, for any push at all). Running that per retry attempt would
  # make every allocation take minutes and would itself hammer the machine
  # under real contention (found by running this script's own concurrency
  # test before this fix: ten racers spawned ten full `verify` runs each
  # retry, each spawning its own subprocess tree). `--no-verify` only skips
  # the CLIENT-side hook for this one push -- it has no effect on the
  # remote's own acceptance of the ref, so the lease guarantee above is
  # untouched.
  if git push --quiet --no-verify "$GIT_REMOTE" "${LOCK_SHA}:${ref}" --force-with-lease="${ref}:" 2>/dev/null; then
    allocated="$candidate"
    break
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -le "$MAX_ATTEMPTS" ]; then
    sleep "$RETRY_SLEEP_SECONDS"
  fi
done

if [ -z "$allocated" ]; then
  echo "$SELF_NAME: could not confirm a module number allocation for db/imports/$IMPORT_NAME/ after $MAX_ATTEMPTS attempts against $GIT_REMOTE." >&2
  echo "This is NOT the same as 'no number available' -- either contention is unusually high (another branch is claiming numbers as fast as this one retries) or the push itself is failing for an unrelated reason (auth, network). Refusing to guess a number rather than hand out an unconfirmed one." >&2
  exit 2
fi

printf '%s\n' "$allocated"
echo "$SELF_NAME: allocated db/imports/$IMPORT_NAME/$allocated (reservation: ${LOCK_PREFIX}/${IMPORT_NAME}/${allocated} on $GIT_REMOTE, permanent, no release needed). Create db/imports/$IMPORT_NAME/${allocated}_<description>.sql using this number." >&2
