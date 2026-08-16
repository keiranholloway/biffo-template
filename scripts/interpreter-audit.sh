#!/usr/bin/env bash
#
# Does every workflow invoke each script with the shell that script actually
# needs?
#
# ## Why this exists (#1603, second-pass verdict on #1619)
#
# #1619 added `run: sh scripts/ci-wiring-audit.sh` to release-guards.yml.
# `ci-wiring-audit.sh` declares `#!/usr/bin/env bash` and uses
# `set -uo pipefail`. The runner's `/bin/sh` on `ubuntu-24.04` is dash
# 0.5.12, and that dash build has no `-o pipefail` in any form: the script
# died at its own `set` line with `Illegal option -o pipefail`, exit 2,
# before reading a single instruction of the audit it exists to run. Had it
# merged, "Release Guards" -- a REQUIRED check -- would have failed
# unconditionally on every future pull request: strictly worse than the
# silent no-caller gap #1619 was written to close, because a red gate people
# cannot fix trains them to stop reading it (AGENTS.md §9).
#
# Two facts make this a recurring class rather than a one-off typo:
#
#   1. This workstation's own dash (Ubuntu 26.04) silently ACCEPTS
#      `set -o pipefail`. Verifying `sh scripts/ci-wiring-audit.sh` here
#      before landing #1619 genuinely printed `wired`, 0 findings -- true on
#      this machine's dash and false on the runner's.
#   2. `dash -n` (syntax check) does NOT catch it. It is a RUNTIME
#      option-parse failure, not a parse error -- `set -o pipefail` is
#      syntactically valid POSIX `set` usage that dash rejects only once it
#      actually executes. The estate's standing "validate with `dash -n` AND
#      `bash -n`" rule is insufficient for this class, and every agent has
#      been briefed with exactly that insufficient rule. THIS SCRIPT is what
#      catches it instead -- by comparing declared shebang against invoking
#      interpreter, never by trying to parse or execute the target.
#
# A sweep of this repo found six scripts carrying a bash shebang plus
# `pipefail` (`ci-wiring-audit.sh`, `branch-health.sh`, `checkout-audit.sh`,
# `hook-audit.sh`, `wait-for-checks.sh`, `gate-coverage.sh`). Five of the six
# have no workflow caller at all today -- the hazard is latent, not active,
# in those -- but "no caller yet" is exactly the condition #1619 changed for
# the sixth with no warning. It will recur the next time any of the other
# five (or a script like them) gains one.
#
# ## What this checks
#
# For every `.github/workflows/*.yml` / `*.yaml` file, every line that
# invokes a repo script with an EXPLICIT `sh` or `bash` interpreter --
# whether a single-line `run: sh scripts/x.sh` or an indented command inside
# a `run: |` block. For each such invocation, read the target script's own
# shebang and compare:
#
#   invoked `sh`,   shebang declares `bash` -> FAIL. This is #1619's defect
#                    exactly: dash cannot run a script written to need bash
#                    (pipefail, `[[`, arrays, ...) and the failure is a
#                    runtime crash, not a lint finding.
#   invoked `bash`, shebang declares `sh`   -> not flagged. bash runs a
#                    POSIX script as a safe superset; there is no crash risk
#                    in this direction, which is why the task that specified
#                    this guard says "or vice versa WHERE IT MATTERS" rather
#                    than symmetrically. Flagging it would just be noise.
#
# Scripts are resolved by basename under `scripts/` -- every current
# invocation in this repo's workflows is `scripts/<name>.sh` or
# `../scripts/<name>.sh` from a subdirectory's `working-directory`. Same
# working-directory-independence problem `ci-wiring-audit.sh`'s own header
# documents for the raw-command class it checks, solved the same way: match
# on what script is named, not what path a particular step's `cwd` makes it
# resolve to.
#
# ## The denominator
#
# Printed unconditionally, before any verdict: how many workflow files were
# read, and how many explicit-interpreter script invocations were examined
# inside them. #1413 is the standing lesson this repeats -- a guard whose
# `requiresCiStep` map held exactly one entry for months still reported
# "checked 1 glob, wired" and read as full coverage. A guard about a check
# that never ran (this file's own reason for existing) must not itself run
# over zero invocations and call that a pass.
#
# ## Written portable on purpose
#
# The shebang says bash, matching the sibling audit scripts in this
# directory, but the body below is plain POSIX `sh` -- no `[[`, no bash
# arrays, no `local`. That is deliberate self-consistency: a script whose
# entire job is "the declared shell and the invoking shell must agree" has
# no business being the shell it cannot itself run under. It is invoked with
# `bash` below (matching its shebang exactly, so the audit does not flag
# itself), but nothing here would actually break if a future edit invoked it
# with `sh` instead -- unlike the script that started this issue.
#
# ## Where this lives, and why
#
# `.github/workflows/release-guards.yml` -- a `filesFromSkeleton` `sync`
# entry (shared-files.json), REQUIRED, and already runs on every pull
# request in the template and every satellite it reaches. This script
# itself is deliberately NOT in the shared set: like `ci-wiring-audit.sh`,
# a satellite has its own `.github/workflows/` and `scripts/`, so running
# this there would be meaningful, but the mechanism to reach it is
# `filesFromSkeleton`/skeleton sync landing it as a plain committed script,
# not the manifest-driven estate walk `ci-wiring-audit.sh --estate` does --
# there is no per-repo estate list this needs. It runs unconditionally here
# (no `hashFiles('shared-files.json')` gate like the CI wiring audit uses):
# unlike that script, this one reads no manifest and has nothing that would
# make it exit 2 in a repo lacking one.
#
# No ratchet: verified before landing (this PR) that fixing the two live
# mismatches this script found -- `ci-wiring-audit.sh` in release-guards.yml
# and a second, independent instance in shared-sync-report.yml
# (`shared-sync.sh`, already dash-safe internally but invoked via `sh`
# against a `bash` shebang) -- brings this repo to zero findings. A bare
# failing gate is the honest shape for a scope with no pre-existing residue
# to protect (same reasoning `ci-wiring-audit.sh`'s own header gives for
# skipping a ratchet); a ratchet is for debt being deliberately deferred, and
# there is none left here.
#
# Usage:
#   bash scripts/interpreter-audit.sh
#
# Exit 0: every explicit-interpreter invocation matches its script's shebang.
# Exit 1: at least one `sh`-invokes-`bash-shebang` mismatch found.
# Exit 2: not a git repo, or `.github/workflows/` holds no workflow files --
#         this audit checked nothing, which is a configuration error, not a
#         pass.

set -u
(set -o pipefail) 2>/dev/null && set -o pipefail || true

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "not a git repo" >&2
  exit 2
}
cd "$ROOT" || exit 2

WF_DIR=".github/workflows"
if [ ! -d "$WF_DIR" ]; then
  echo "no $WF_DIR -- this audit checked nothing" >&2
  exit 2
fi

WF_FILES=""
WF_COUNT=0
for f in "$WF_DIR"/*.yml "$WF_DIR"/*.yaml; do
  [ -f "$f" ] || continue
  WF_FILES="$WF_FILES $f"
  WF_COUNT=$((WF_COUNT + 1))
done

if [ "$WF_COUNT" -eq 0 ]; then
  echo "$WF_DIR holds no *.yml/*.yaml -- this audit checked nothing" >&2
  exit 2
fi

# shebang_shell <script-path>
#
# Prints the interpreter name from a script's first line (`bash` or `sh`) on
# stdout and returns 0, or returns 1 with nothing printed. Handles both
# `#!/bin/bash` and `#!/usr/bin/env bash` forms by taking the shebang line's
# last whitespace-separated token and its final path segment.
shebang_shell() {
  first_line=$(head -n1 "$1" 2>/dev/null) || return 1
  case "$first_line" in
    '#!'*) : ;;
    *) return 1 ;;
  esac
  # "#!/usr/bin/env bash" and "#!/bin/bash" both need the LAST field taken
  # (the interpreter, not the `env` indirection), then basename'd -- a plain
  # "#!/bin/bash" is one field and survives basename unchanged.
  interpreter=$(printf '%s\n' "$first_line" | sed -e 's/^#!//' | awk '{print $NF}')
  interpreter=$(basename "$interpreter")
  case "$interpreter" in
    bash | sh) printf '%s\n' "$interpreter" ;;
    *) return 1 ;;
  esac
}

invocations=0
failed=0

for f in $WF_FILES; do
  # One `interpreter<TAB>path` pair per matching line, `lineno` prefixed so
  # each finding can point back at the exact line. `grep -noE` gives us
  # `LINE:MATCH`; the pattern intentionally allows the interpreter to appear
  # anywhere on the line (covers `run: sh scripts/x.sh` and an indented
  # command inside a `run: |` block alike), same shape as `ci-wiring-audit.sh`'s
  # `raw_hits`.
  hits=$(grep -noE '(^|[[:space:]])(sh|bash)[[:space:]]+[^[:space:]]+\.sh' "$f" || true)
  [ -n "$hits" ] || continue

  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    lineno=${hit%%:*}
    rest=${hit#*:}
    # `rest` is now e.g. " sh scripts/x.sh" or "bash scripts/x.sh" -- strip
    # any single leading space the alternation's `(^|[[:space:]])` captured.
    rest=${rest# }
    interpreter=$(printf '%s\n' "$rest" | awk '{print $1}')
    raw_path=$(printf '%s\n' "$rest" | awk '{print $2}')
    base=$(basename "$raw_path")
    script="scripts/$base"

    invocations=$((invocations + 1))
    line_text=$(sed -n "${lineno}p" "$f")

    if [ ! -f "$script" ]; then
      printf '  %s:%s  invokes '\''%s'\'' via %s -- not found at %s, skipped (audit only resolves scripts/<name>.sh)\n' \
        "$f" "$lineno" "$base" "$interpreter" "$script"
      continue
    fi

    shebang=$(shebang_shell "$script") || {
      printf '  %s:%s  %s has no bash/sh shebang to compare against, skipped\n' "$f" "$lineno" "$script"
      continue
    }

    if [ "$interpreter" = "sh" ] && [ "$shebang" = "bash" ]; then
      failed=1
      printf '  \033[31mMISMATCH\033[0m %s:%s\n' "$f" "$lineno"
      printf '           line:    %s\n' "$line_text"
      printf '           invoked with: sh\n'
      printf '           script:       %s\n' "$script"
      printf '           shebang:      #!/usr/bin/env bash\n'
      printf '           dash (the runner'"'"'s /bin/sh) has no pipefail and can crash on\n'
      printf '           other bashisms this script may use. Invoke with bash instead.\n'
    fi
  done <<EOF
$hits
EOF
done

# The denominator, printed unconditionally before any verdict -- see header,
# #1413.
printf 'interpreter audit: checked %s workflow file(s), %s explicit-interpreter script invocation(s)\n\n' \
  "$WF_COUNT" "$invocations"

if [ "$failed" -ne 0 ]; then
  printf '\033[31mAt least one workflow invokes a bash-shebang script with sh.\033[0m\n'
  printf 'dash (the GitHub-hosted runner'"'"'s /bin/sh) does not support pipefail\n'
  printf 'and can crash on other bashisms before the script does anything --\n'
  printf 'this workstation'"'"'s own dash may tolerate the same line, which is\n'
  printf 'exactly how this class ships unnoticed (#1603). `dash -n`/`bash -n`\n'
  printf 'do NOT catch it: it is a runtime option-parse failure, not a syntax\n'
  printf 'error. Fix: change the invoking interpreter to match the shebang.\n\n'
  exit 1
fi

printf '\033[32mEvery explicit-interpreter script invocation matches its shebang.\033[0m\n\n'
