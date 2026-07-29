#!/usr/bin/env bash
#
# Does each repo's CI actually CALL the shared scripts it has been given?
#
# ## Why this exists
#
# On 2026-07-29 `shared-sync.sh` distributed the two hardened dependency-audit
# scripts to twelve satellites, eleven PRs merged, and `--check` went clean. It
# changed **nothing**: every one of those repos still ran the raw
# `pnpm audit --audit-level=high` / `uv run pip-audit` in its own `ci.yml`, so
# the scripts sat in the tree uncalled and every repo carried on reddening a
# required check on any registry hiccup — the exact defect they were written to
# fix (#591, #743, #883).
#
# Drift went to zero and the outcome did not move. That is the same shape as
# the arming metric reading 100% while six repos ran one check in eight: a
# **proxy reported as the outcome**. `shared-sync.sh` answers "did the file
# land". This answers "does anything call it", which is the question that was
# actually being asked.
#
# ## Why this cannot be shared-sync's job
#
# `ci.yml` is legitimately repo-owned. Its jobs, runner labels and
# `working-directory` differ per repo, so it can never be a one-way overwrite —
# `sh scripts/py-dependency-audit.sh` is right at a repo root and
# `sh ../../scripts/py-dependency-audit.sh` is right under `services/api`. That
# is why #884 needed twelve hand edits, and why nothing prompted them.
#
# So this is the third distribution question, and the one neither existing
# mechanism covers:
#
#   biffo core upgrade   template-owned paths, in instances        (3-way merge)
#   shared-sync.sh       byte-identical files, in satellites       (overwrite)
#   THIS                 one line, at a path only that repo knows  (assertion)
#
# An assertion is the right shape for the third: you cannot write the line for
# the repo, but you can refuse to let it forget. Every future gate change has
# this shape, so the mapping is data — `supersedes` in `shared-files.json` —
# rather than these two scripts hardcoded.
#
# ## Why this one is NOT in shared-files.json
#
# `hook-audit.sh` and `gate-coverage.sh` are distributed to every satellite;
# this one deliberately is not. It reads `shared-files.json` for its mapping,
# and that manifest exists only here — a satellite carrying this script would
# find no manifest and exit 2 on every run, which is worse than not having it.
# It is an estate audit run FROM the template, like `shared-sync.sh` itself.
#
# Usage:
#   sh scripts/ci-wiring-audit.sh                 # this repo
#   sh scripts/ci-wiring-audit.sh --estate ~/code # every repo under a directory
#
# Exits non-zero if any repo runs a raw command a shared script supersedes.

set -uo pipefail

ESTATE=""
[ "${1:-}" = "--estate" ] && ESTATE="${2:-}"

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "not a git repo" >&2
  exit 2
}
MANIFEST="$ROOT/shared-files.json"
[ -f "$MANIFEST" ] || {
  echo "no shared-files.json at $MANIFEST" >&2
  exit 2
}

# `script<TAB>raw-pattern` per line, from the manifest's `supersedes` map. Read
# with node rather than grepped: the manifest carries a multi-paragraph `note`
# that a line-based parse would trip over.
PAIRS=$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  for (const [script, pats] of Object.entries(m.supersedes ?? {}))
    for (const p of pats) process.stdout.write(`${script}\t${p}\n`)
' "$MANIFEST")

if [ -z "$PAIRS" ]; then
  # Exit 2, not 0. An empty map means this audit checked NOTHING, and 0 is the
  # code the daily collector renders as `OK` — so deleting the map would turn
  # the audit green across the whole estate, which is precisely the fail-open
  # this script exists to catch one layer down. 2 is "cannot run", distinct
  # from 1 "found something".
  printf '\033[31mshared-files.json declares no `supersedes` map.\033[0m\n' >&2
  printf 'This audit checked nothing. That is a configuration error, not a pass.\n' >&2
  exit 2
fi

# A raw command still being RUN, as opposed to mentioned.
#
# Only `run:` lines count. Both skeleton workflows explain the switch in a
# comment directly above the step — including the raw command's name — so a
# plain substring search over the file reports every correctly-wired repo as
# broken. Verified against `_skeletons/*/ci.yml`, which must come out clean.
#
# A line naming the shared script is never a violation even if it also contains
# the raw string, so a wrapper named after what it replaces cannot trip it.
raw_hits() {
  f="$1"
  script="$2"
  pattern="$3"
  base=$(basename "$script")
  grep -nE '^[[:space:]]*(-[[:space:]]+)?run:' "$f" 2>/dev/null |
    grep -F "$pattern" |
    grep -vF "$base" || true
}

failed=0

report() {
  d="$1"
  label="$2"

  wf_dir="$d/.github/workflows"
  if [ ! -d "$wf_dir" ]; then
    printf '%-26s \033[90mno workflows\033[0m\n' "$label"
    return
  fi

  held=0
  unwired=""
  # `printf | while` would run the loop in a subshell and lose every variable
  # set inside it -- the classic way a shell audit reports clean. Here-string
  # via a heredoc keeps the loop in this shell.
  while IFS="$(printf '\t')" read -r script pattern; do
    [ -n "$script" ] || continue
    # Only meaningful where the repo actually HAS the script: a repo that was
    # never given it is shared-sync's problem, not this one, and reporting it
    # here would double-count one defect as two.
    [ -f "$d/$script" ] || continue
    held=$((held + 1))
    for f in "$wf_dir"/*.yml "$wf_dir"/*.yaml; do
      [ -f "$f" ] || continue
      hits=$(raw_hits "$f" "$script" "$pattern")
      [ -n "$hits" ] || continue
      n=$(printf '%s\n' "$hits" | grep -c .)
      unwired="$unwired $(basename "$f"):$pattern($n)"
    done
  done <<EOF
$PAIRS
EOF

  if [ "$held" -eq 0 ]; then
    printf '%-26s \033[90mholds no shared script that supersedes anything\033[0m\n' "$label"
    return
  fi

  if [ -n "$unwired" ]; then
    failed=1
    printf '%-26s \033[31mUNWIRED\033[0m %s\n' "$label" "$unwired"
  else
    printf '%-26s \033[32mwired\033[0m\n' "$label"
  fi
}

printf '\nCI wiring - does each repo CALL the shared scripts it holds\n\n'
if [ -n "$ESTATE" ]; then
  for d in "$ESTATE"/*/; do
    [ -e "$d/.git" ] || continue
    report "${d%/}" "$(basename "${d%/}")"
  done
else
  report "$ROOT" "$(basename "$ROOT")"
fi

printf '\n'
if [ "$failed" -ne 0 ]; then
  printf '\033[31mSome repos hold a shared script and still run the raw command.\033[0m\n'
  printf 'The file landing is not the fix -- nothing calls it, so the defect it\n'
  printf 'was written for is still live. Edit that repo`s ci.yml: the path is\n'
  printf 'relative to that step`s working-directory (see _skeletons/*/ci.yml).\n\n'
  exit 1
fi
printf '\033[32mEvery repo calls the shared scripts it holds.\033[0m\n\n'
