#!/usr/bin/env sh
#
# Guard for #1709: every `audit_json` call in practices-daily.sh must invoke
# a bash-shebang script as a bare executable path (or via `scripts/biffo.sh`,
# whose own shebang IS `sh`), never as an explicit `sh scripts/<name>.sh`.
#
# ## The defect this reproduces
#
# `practices-daily.sh`'s `deploy` audit ran
# `sh scripts/branch-health.sh -R "$_slug" --quiet`. `branch-health.sh`
# declares `#!/usr/bin/env bash` and needs it -- `set -uo pipefail` at its own
# top. An explicit `sh` prefix discards that shebang and hands the script to
# whatever `sh` resolves to instead: dash. This workstation's dash (Ubuntu
# 26.04, 0.5.12-12ubuntu3) happens to tolerate `set -o pipefail` at runtime;
# the GitHub-hosted runner's (ubuntu-24.04, 0.5.12-6ubuntu5, per
# branch-health-workflow-run-attribution.test.sh's own header, verified there
# against a genuine `docker run ubuntu:24.04`) rejects it with
# "Illegal option -o pipefail", exit 2, before the script does anything. Every
# integration branch in the `deploy` audit's loop then read as failing without
# one ever having been measured -- a fail-open dressed as a red result.
#
# `dash -n`/`bash -n` do NOT catch this: it is a runtime option-parse failure,
# not a syntax error (both exit 0 against branch-health.sh unchanged).
#
# The same class turned up four more times in this file's own audit_json
# calls once swept: `coverage` (gate-coverage.sh), `protection`
# (protection-audit.sh), `wiring` (ci-wiring-audit.sh) and `checkout`
# (checkout-audit.sh) all carry `#!/usr/bin/env bash` + `set -uo pipefail` and
# were all invoked the same broken way. All five are fixed by dropping the
# explicit `sh` prefix so the kernel dispatches per each script's own
# shebang -- the same fix branch-health-plan-only-detection.test.sh already
# carries for a direct invocation of branch-health.sh.
#
# `scripts/biffo.sh` is deliberately exempt: it declares `#!/usr/bin/env sh`
# itself, so `sh scripts/biffo.sh <subcommand>` is not a mismatch at THIS
# call site (`arming`, and every `sh scripts/biffo.sh …` elsewhere in this
# repo). `scripts/shared-sync.sh` is also deliberately exempt: its shebang
# says bash (matching sibling audit scripts) but its body guards
# `set -o pipefail` conditionally --
# `(set -o pipefail) 2>/dev/null && set -o pipefail || true` -- specifically
# so it tolerates being invoked via `sh` on a dash that rejects the option;
# see its own header comment for the history (#883 class). Neither is a
# residual instance of #1709's defect and this test must not flag them.
#
# ## What this checks
#
# For every `audit_json <name> "<cmd>" ...` call in practices-daily.sh, find
# every explicit `sh scripts/<name>.sh` token inside `<cmd>` (the same shape
# whether it is the whole command or embedded in a `;`/`&&`-joined compound
# one, as the `deploy` audit's loop body is) and compare the invoked
# script's own shebang. `sh` invoking a `bash`-shebang script that has NOT
# been placed on the deliberate-exception allowlist above is the defect.
#
# Run: sh scripts/practices-daily-sh-invocation.test.sh
# Exit 0 = every audit_json invocation matches its target's shebang (or is on
#          the deliberate-exception allowlist).
# Exit 1 = at least one audit_json call still forces a bash-shebang script
#          through an explicit `sh`.

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DAILY="$REPO_ROOT/scripts/practices-daily.sh"

[ -f "$DAILY" ] || { echo "FAIL: $DAILY not found" >&2; exit 1; }

# Deliberate exceptions: `sh` invoking these is documented and safe. See the
# header above for why each one is not the #1709 defect.
is_exception() {
  case "$1" in
    biffo.sh | shared-sync.sh) return 0 ;;
    *) return 1 ;;
  esac
}

shebang_shell() {
  first_line=$(head -n1 "$1" 2>/dev/null) || return 1
  case "$first_line" in
    '#!'*) : ;;
    *) return 1 ;;
  esac
  interpreter=$(printf '%s\n' "$first_line" | sed -e 's/^#!//' | awk '{print $NF}')
  basename "$interpreter"
}

fail=0
checked=0

# Only the audit_json call lines -- not the comments around them, which
# freely mention "sh scripts/…" in prose and are not invocations.
audit_lines=$(grep -n '^audit_json ' "$DAILY")

old_ifs=$IFS
IFS='
'
for line in $audit_lines; do
  lineno=${line%%:*}
  content=${line#*:}

  # Every explicit `sh scripts/<name>.sh` token inside this line's command
  # string, however it is joined to neighbours (`;`, `&&`, a bare space).
  rest=$content
  while true; do
    case "$rest" in
      *'sh scripts/'*) : ;;
      *) break ;;
    esac
    after=${rest#*sh scripts/}
    # Up to the next non-path character.
    token=$after
    token=${token%%[!A-Za-z0-9_./-]*}
    script="scripts/$token"
    base=$(basename "$token")
    checked=$((checked + 1))

    if is_exception "$base"; then
      : # deliberate, see header
    else
      target="$REPO_ROOT/$script"
      if [ -f "$target" ]; then
        shebang=$(shebang_shell "$target") || shebang=""
        if [ "$shebang" = "bash" ]; then
          fail=1
          echo "FAIL: practices-daily.sh:$lineno invokes '$script' via explicit sh, but it declares #!/usr/bin/env bash" >&2
          echo "  line: $content" >&2
        fi
      fi
    fi

    rest=$after
  done
done
IFS=$old_ifs

if [ "$checked" -eq 0 ]; then
  echo "FAIL: found zero 'sh scripts/…' tokens across audit_json calls -- this test checked nothing" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "PASS: $checked explicit 'sh scripts/…' invocation(s) in audit_json calls, none forcing a bash-shebang script through sh."
exit 0
