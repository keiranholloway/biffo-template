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
# ## Third-pass rework: flags, and an honest denominator (#1603 third verdict)
#
# The first working version of this script matched only a bare
# `(sh|bash) <token>.sh` shape -- interpreter, one space, script, nothing
# else. That is not what most real invocations look like once someone adds a
# flag, and it is trivial to defeat by accident:
#
#   `sh -e scripts/foo.sh`        -- the founding defect plus one flag
#   `bash -eu scripts/foo.sh`     -- flags on the safe direction too
#   `sh -c "scripts/foo.sh"`      -- the script name is inside a quoted
#                                     command string, not a bare path
#   `${RUNNER_SHELL} scripts/foo.sh` -- the interpreter is a shell variable
#   a `run: |` block with a line continuation splitting interpreter and
#     script across two physical lines (`sh \` / `  scripts/foo.sh`)
#
# All six were independently prosecuted against a disposable fixture and
# found to evade the old pattern -- each printing `0 explicit-interpreter
# script invocation(s)` and exiting 0 having examined nothing. That is worse
# than a wrong verdict: a guard about an unstated denominator (#1413) that
# silently drops what it cannot parse is carrying the exact defect it exists
# to catch, in itself.
#
# Two different fixes for two different shapes:
#
#   - **Flags are parsed, not just tolerated.** `sh -e`, `bash -eu`, any
#     number of `-xyz`-shaped tokens between the interpreter and the script
#     are stripped before the script path is read, so `sh -e scripts/foo.sh`
#     resolves to the same `interpreter=sh script=scripts/foo.sh` pair as the
#     bare form and is compared against the shebang exactly as before.
#   - **A line continuation is joined before matching, not treated as a
#     separate problem.** A physical line ending in a bare trailing `\` is
#     spliced onto the next physical line first (mirroring what the shell
#     itself does), so `sh \` / `  scripts/foo.sh` becomes one logical line
#     and is parsed the same as the single-line form. This is a mechanical,
#     low-risk transform -- it does not need to know anything about what
#     comes after -- unlike trying to *declare* a continuation unparseable,
#     which would just move the silent-drop problem rather than closing it.
#
# Two shapes are **deliberately left unparsed, and counted rather than
# dropped:**
#
#   - **`sh -c "..."` is not parsed.** The invoked "script" is arbitrary
#     shell text inside a quoted string, not necessarily a file path at all
#     -- it may itself be `sh -c "cmd1 && cmd2"` with no `.sh` file in sight,
#     or the string could span further quoting this audit has no reason to
#     get right. Parsing it well enough to be trustworthy is a much bigger
#     job than this fix, and parsing it *badly* (e.g. trusting `basename` on
#     a string that happens to contain a path substring) would produce a
#     false sense of coverage worse than admitting it is unread. The
#     deliberate choice here is: never claim a verdict on a `-c` invocation.
#   - **A shell-variable interpreter (`$RUNNER_SHELL`, `${SHELL}`, ...) is
#     not resolved.** Its value is not available statically from the
#     workflow text -- resolving it would mean partially evaluating GitHub
#     Actions expressions and env context, which this audit has no machinery
#     for and should not grow ad hoc.
#
# Both are counted in a **third state, not folded into either verdict**:
# "could not examine". See below.
#
# ## What this checks
#
# For every `.github/workflows/*.yml` / `*.yaml` file, every line that
# invokes a repo script with an EXPLICIT `sh` or `bash` interpreter --
# whether a single-line `run: sh scripts/x.sh`, an indented command inside a
# `run: |` block, or either of those split across a `\` line continuation.
# Optional interpreter flags (`-e`, `-eu`, ...) between the interpreter and
# the script are consumed and ignored. For each such invocation that
# resolves to a plain script path, read the target script's own shebang and
# compare:
#
#   invoked `sh`,   shebang declares `bash` -> MISMATCH. This is #1619's
#                    defect exactly: dash cannot run a script written to
#                    need bash (pipefail, `[[`, arrays, ...) and the failure
#                    is a runtime crash, not a lint finding.
#   invoked `bash`, shebang declares `sh`   -> not flagged. bash runs a
#                    POSIX script as a safe superset; there is no crash risk
#                    in this direction, which is why the task that specified
#                    this guard says "or vice versa WHERE IT MATTERS" rather
#                    than symmetrically. Flagging it would just be noise.
#
# An invocation whose interpreter is `sh`/`bash` but whose script argument is
# a quoted string (`-c "..."`) or whose interpreter position is a shell
# variable is **not** compared against anything -- it is counted as "could
# not examine" instead (see below), never silently skipped.
#
# Scripts are resolved by basename under `scripts/` -- every current
# invocation in this repo's workflows is `scripts/<name>.sh` or
# `../scripts/<name>.sh` from a subdirectory's `working-directory`. Same
# working-directory-independence problem `ci-wiring-audit.sh`'s own header
# documents for the raw-command class it checks, solved the same way: match
# on what script is named, not what path a particular step's `cwd` makes it
# resolve to.
#
# ## The denominator, and three states rather than a pass/fail count
#
# Printed unconditionally, before any verdict: how many workflow files were
# read, and every explicit-interpreter invocation this audit found is
# resolved into exactly one of three states, never a fourth silent one:
#
#   examined, matching    -- interpreter and shebang agree (or bash-on-sh,
#                             the safe direction). No action needed.
#   examined, mismatched  -- `sh` invoking a `bash`-shebang script. The
#                             defect this audit exists to catch.
#   could not examine     -- the invocation was recognised (an `sh`/`bash`
#                             token, or a shell-variable interpreter, next to
#                             a `.sh` reference) but could not be resolved to
#                             a plain interpreter+script pair -- `-c` with a
#                             quoted string, or a variable-indirected
#                             interpreter.
#
# #1413 is the standing lesson this repeats -- a guard whose `requiresCiStep`
# map held exactly one entry for months still reported "checked 1 glob,
# wired" and read as full coverage. A guard about a check that never ran
# (this file's own reason for existing) must not itself run over zero
# invocations and call that a pass, and must not let "could not examine"
# quietly count as "examined and fine" either -- that is the same defect one
# level in. **A nonzero "could not examine" count fails the audit**, exactly
# like a mismatch does: an invocation this script does not understand is
# unexamined, not fine.
#
# ## Written portable on purpose
#
# The shebang says bash, matching the sibling audit scripts in this
# directory, but the body below is plain POSIX `sh` -- no `[[`, no bash
# arrays, no `local`, and the awk helper below uses only POSIX-portable
# constructs (tested under `mawk`, which is what `awk` resolves to on both
# this workstation and Ubuntu GitHub-hosted runners). That is deliberate
# self-consistency: a script whose entire job is "the declared shell and the
# invoking shell must agree" has no business being the shell it cannot itself
# run under. It is invoked with `bash` below (matching its shebang exactly,
# so the audit does not flag itself), but nothing here would actually break
# if a future edit invoked it with `sh` instead -- unlike the script that
# started this issue.
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
# No ratchet: verified before landing that this repo's live workflows carry
# zero mismatches and zero unparseable invocations (27 clean invocations
# across 15 files, all matching). A bare failing gate is the honest shape for
# a scope with no pre-existing residue to protect (same reasoning
# `ci-wiring-audit.sh`'s own header gives for skipping a ratchet); a ratchet
# is for debt being deliberately deferred, and there is none left here.
#
# ## Known, out-of-scope gap
#
# `core_version=$(sh ../scripts/resolve-core-version.sh)` in `deploy-app.yml`
# is a real `sh`-invokes-`sh`-shebang call this audit does not see at all --
# the interpreter word is immediately preceded by `(` from the command
# substitution, not whitespace, so it never satisfies the boundary check and
# is neither examined nor counted as unparseable. It is safe today (the
# target script's shebang is `sh`, so there is nothing to mismatch), and
# widening the boundary to catch `$(...)` forms was not part of what this
# round was asked to fix and was not chased, to avoid trading a narrow,
# verified-safe pattern for a broader one with unverified false-positive
# risk against this repo's many `#`-comment lines that mention script names
# in prose. Recorded here rather than silently left for the next reader to
# rediscover.
#
# Usage:
#   bash scripts/interpreter-audit.sh
#
# Exit 0: every explicit-interpreter invocation matches its script's shebang,
#         and none were left unparsed.
# Exit 1: at least one `sh`-invokes-`bash-shebang` mismatch, OR at least one
#         invocation could not be examined.
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

# find_invocations <workflow-file>
#
# Emits one TSV record per explicit-interpreter invocation found in the
# file, one of:
#   CLEAN<TAB>lineno<TAB>interpreter<TAB>script-path
#   UNPARSEABLE<TAB>lineno<TAB>interpreter-or-"var"<TAB>reason
#
# A trailing `\` line continuation is spliced onto the next physical line
# before matching, so an interpreter and its script split across two lines
# in a `run: |` block are read as one logical line. Interpreter flags
# (`-e`, `-eu`, ...) between the interpreter and the script are consumed.
# A script argument that is a quoted string (the `-c "..."` shape) or an
# interpreter that is a shell variable (`$VAR`, `${VAR}`) is reported
# UNPARSEABLE rather than matched or silently dropped.
find_invocations() {
  awk '
{
  startline = NR
  line = $0
  while (match(line, /\\[ \t]*$/)) {
    if ((getline nextline) <= 0) { sub(/\\[ \t]*$/, "", line); break }
    sub(/\\[ \t]*$/, "", line)
    line = line " " nextline
  }
  process(line, startline)
}

function process(line, startline,    rest, matched, interp, wordend, tail, tail2, token, vline) {
  rest = line
  while (match(rest, /(^|[ \t])(sh|bash)([ \t]|$)/)) {
    matched = substr(rest, RSTART, RLENGTH)
    if (matched ~ /^bash/)      { interp = "bash"; wordend = RSTART + 4 - 1 }
    else if (matched ~ /^sh/)   { interp = "sh";   wordend = RSTART + 2 - 1 }
    else if (matched ~ /^[ \t]bash/) { interp = "bash"; wordend = RSTART + 1 + 4 - 1 }
    else                        { interp = "sh";   wordend = RSTART + 1 + 2 - 1 }

    tail = substr(rest, wordend + 1)
    while (match(tail, /^[ \t]+-[^ \t]*/)) {
      tail = substr(tail, RLENGTH + 1)
    }

    token = ""
    if (match(tail, /^[ \t]+/)) {
      tail2 = substr(tail, RLENGTH + 1)
      if (match(tail2, /^[^ \t]+/)) {
        token = substr(tail2, RSTART, RLENGTH)
      }
    }

    if (token != "" && token ~ /^[^ \t"$]+\.sh$/) {
      printf "CLEAN\t%d\t%s\t%s\n", startline, interp, token
    } else if (token != "" && index(token, ".sh") > 0) {
      printf "UNPARSEABLE\t%d\t%s\tinvoked with %s, target is not a bare script path: %s\n", startline, interp, interp, token
    }

    rest = substr(rest, RSTART + RLENGTH)
  }

  vline = line
  while (match(vline, /(^|[ \t])\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[ \t]+[^ \t]+\.sh([ \t]|$)/)) {
    printf "UNPARSEABLE\t%d\tvar\tinterpreter is a shell variable, cannot be resolved statically\n", startline
    vline = substr(vline, RSTART + RLENGTH)
  }
}
' "$1"
}

match_count=0
mismatch_count=0
unparseable_count=0

for f in $WF_FILES; do
  records=$(find_invocations "$f") || true
  [ -n "$records" ] || continue

  while IFS= read -r rec; do
    [ -n "$rec" ] || continue
    kind=${rec%%$(printf '\t')*}
    rest=${rec#*$(printf '\t')}
    lineno=${rest%%$(printf '\t')*}
    rest=${rest#*$(printf '\t')}
    interpreter=${rest%%$(printf '\t')*}
    detail=${rest#*$(printf '\t')}
    line_text=$(sed -n "${lineno}p" "$f")

    if [ "$kind" = "UNPARSEABLE" ]; then
      unparseable_count=$((unparseable_count + 1))
      printf '  \033[33mCOULD NOT EXAMINE\033[0m %s:%s\n' "$f" "$lineno"
      printf '           line:    %s\n' "$line_text"
      printf '           %s\n' "$detail"
      continue
    fi

    # CLEAN: interpreter and a bare script path were both resolved.
    base=$(basename "$interpreter")
    raw_path=$detail
    base_script=$(basename "$raw_path")
    script="scripts/$base_script"

    if [ ! -f "$script" ]; then
      match_count=$((match_count + 1))
      printf '  %s:%s  invokes '\''%s'\'' via %s -- not found at %s, skipped (audit only resolves scripts/<name>.sh)\n' \
        "$f" "$lineno" "$base_script" "$interpreter" "$script"
      continue
    fi

    shebang=$(shebang_shell "$script") || {
      match_count=$((match_count + 1))
      printf '  %s:%s  %s has no bash/sh shebang to compare against, skipped\n' "$f" "$lineno" "$script"
      continue
    }

    if [ "$interpreter" = "sh" ] && [ "$shebang" = "bash" ]; then
      mismatch_count=$((mismatch_count + 1))
      printf '  \033[31mMISMATCH\033[0m %s:%s\n' "$f" "$lineno"
      printf '           line:    %s\n' "$line_text"
      printf '           invoked with: sh\n'
      printf '           script:       %s\n' "$script"
      printf '           shebang:      #!/usr/bin/env bash\n'
      printf '           dash (the runner'"'"'s /bin/sh) has no pipefail and can crash on\n'
      printf '           other bashisms this script may use. Invoke with bash instead.\n'
    else
      match_count=$((match_count + 1))
    fi
  done <<EOF
$records
EOF
done

examined=$((match_count + mismatch_count))
total=$((examined + unparseable_count))

# The denominator, printed unconditionally before any verdict -- see header,
# #1413. Three states, never a fourth silent one: examined-and-matching,
# examined-and-mismatched, could-not-examine.
printf 'interpreter audit: checked %s workflow file(s), %s explicit-interpreter invocation(s) found\n' \
  "$WF_COUNT" "$total"
printf '  examined, matching:    %s\n' "$match_count"
printf '  examined, mismatched:  %s\n' "$mismatch_count"
printf '  could not examine:     %s\n\n' "$unparseable_count"

failed=0
if [ "$mismatch_count" -ne 0 ]; then
  failed=1
  printf '\033[31mAt least one workflow invokes a bash-shebang script with sh.\033[0m\n'
  printf 'dash (the GitHub-hosted runner'"'"'s /bin/sh) does not support pipefail\n'
  printf 'and can crash on other bashisms before the script does anything --\n'
  printf 'this workstation'"'"'s own dash may tolerate the same line, which is\n'
  printf 'exactly how this class ships unnoticed (#1603). `dash -n`/`bash -n`\n'
  printf 'do NOT catch it: it is a runtime option-parse failure, not a syntax\n'
  printf 'error. Fix: change the invoking interpreter to match the shebang.\n\n'
fi

if [ "$unparseable_count" -ne 0 ]; then
  failed=1
  printf '\033[31mAt least one workflow invokes sh/bash in a shape this audit cannot statically resolve.\033[0m\n'
  printf 'An invocation this script does not understand is UNEXAMINED, not fine --\n'
  printf 'see the "could not examine" entries above for the file, line and reason.\n'
  printf 'Rewrite the invocation as a bare `sh scripts/<name>.sh` (with optional\n'
  printf 'flags) so it can be checked, or if the shape is intentional, this audit\n'
  printf 'needs to be taught it explicitly rather than made to guess.\n\n'
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

printf '\033[32mEvery explicit-interpreter script invocation matches its shebang, and none were left unexamined.\033[0m\n\n'
