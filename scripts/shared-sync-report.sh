#!/usr/bin/env bash
#
# Decision logic for .github/workflows/shared-sync-report.yml (delivery + report).
#
# Moved out of inline workflow YAML (biffo-template#2166 / #2156 problems 2
# and 5) so it can be tested. Given the outcome of the discover, `--check`
# and delivery (`shared-sync.sh --now`) steps, it decides two things:
#
#   1. RED or GREEN (exit 1 / exit 0).
#      RED only when
#        - we cannot tell: estate discovery failed, `--check` did not
#          complete, exited 2, an unreadable repo, nothing checked, or
#          applicable < 50% of cloned; OR
#        - the delivery round itself failed; OR
#        - a drifted satellite's sync PR (chore/sync-shared) has been open
#          longer than STUCK_HOURS (48) despite a delivered round -- stuck.
#      Clean, or fresh drift with sync PRs opened, is GREEN.
#
#   2. Issue routing. Clean + green: no issue. Otherwise one tracking issue,
#      found by the stable body marker (MARKER) across open AND closed issues
#      (legacy issues without a marker are matched by exact title). Open ->
#      comment; closed -> REOPEN the same number with a comment, so closing a
#      still-true report never files a new number; none -> create.
#
# Inputs (environment):
#   ESTATE_OUTCOME   outcome of the discovery step (success|failure|...)
#   SYNC_OUTCOME     outcome of the --check step
#   CHECK_RC         exit code of `shared-sync.sh --check` (may be empty)
#   CHECK_LOG        path to the --check log
#   DELIVERY_OUTCOME outcome of the delivery step (success|failure|skipped)
#   CLONED           number of candidate repos cloned
#   ESTATE           clone directory (to resolve each drifted repo's slug)
#   RUN_URL          link to the run
#   GITHUB_REPOSITORY  repo the tracking issue lives in
#   GH_TOKEN         token able to read the satellites' PRs
#   ISSUE_GH_TOKEN   token for issue operations (defaults to GH_TOKEN)
#   STUCK_HOURS      default 48
#   NOW_EPOCH        override "now" (tests)
#   SUMMARY_FILE     appended with the report (defaults to $GITHUB_STEP_SUMMARY)

set -u

MARKER='<!-- shared-sync-report -->'
TITLE="shared-sync scheduled report: satellite drift or an unreadable repo detected"
STUCK_HOURS="${STUCK_HOURS:-48}"
SUMMARY_FILE="${SUMMARY_FILE:-${GITHUB_STEP_SUMMARY:-/dev/null}}"
now_s="${NOW_EPOCH:-$(date -u +%s)}"

estate_ok="${ESTATE_OUTCOME:-}"
sync_ran="${SYNC_OUTCOME:-}"
rc="${CHECK_RC:-}"
log="${CHECK_LOG:-}"
delivery="${DELIVERY_OUTCOME:-skipped}"
cloned="${CLONED:-0}"

red=0
reasons=""
add_reason() { red=1; reasons="${reasons}- ${1}
"; }

drifted_n=0
detail=""
stuck_lines=""
pr_lines=""
denom=""

if [ "$estate_ok" != "success" ]; then
  denom="checked 0 satellites, 0 drifted: (could not discover/clone the governed set)"
  add_reason "cannot tell: estate discovery failed, so shared-sync never ran"
elif [ "$sync_ran" != "success" ] || [ -z "$rc" ] || [ ! -r "$log" ]; then
  denom="checked 0 satellites, 0 drifted: (shared-sync --check did not complete)"
  add_reason "cannot tell: shared-sync.sh --check did not complete"
else
  clean="$(mktemp)"
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" > "$clean" 2>/dev/null || cp "$log" "$clean"

  summary_line=$(grep -E '^[0-9]+ current, [0-9]+ drifted' "$clean" | tail -1 || true)
  current_n=$(printf '%s' "$summary_line" | sed -E 's/^([0-9]+) current.*/\1/')
  drifted_n=$(printf '%s' "$summary_line" | sed -E 's/.*, ([0-9]+) drifted.*/\1/')
  case "$current_n" in ''|*[!0-9]*) current_n=0 ;; esac
  case "$drifted_n" in ''|*[!0-9]*) drifted_n=0 ;; esac
  checked_n=$((current_n + drifted_n))

  drifted_names=$(grep -E '^[^[:space:]]+ +DRIFTED' "$clean" | awk '{print $1}' || true)
  names_csv=$(printf '%s' "$drifted_names" | paste -sd, -)
  [ -n "$names_csv" ] || names_csv="(none)"

  unreadable=$(grep -c 'cannot fetch\|repo(s) could not be read' "$clean" || true)
  applicable_line=$(grep -E '^[0-9]+ of [0-9]+ repo\(s\) under .* judged applicable by applies\(\)' "$clean" | tail -1 || true)
  applicable_n=$(printf '%s' "$applicable_line" | sed -E 's/^([0-9]+) of.*/\1/')
  case "$applicable_n" in ''|*[!0-9]*) applicable_n=0 ;; esac

  denom="cloned ${cloned}, applicable ${applicable_n}, checked ${checked_n} satellites, ${drifted_n} drifted: ${names_csv}"

  # ---- cannot tell ----
  if [ -z "$applicable_line" ]; then
    refusal=$(grep -m1 -E 'shared-sync: (this template checkout is|surveyed zero)' "$clean" || true)
    add_reason "cannot tell: --check exited ${rc} before surveying anything (applicable is ABSENT, not 0). ${refusal}"
  elif [ "$cloned" -gt 0 ] 2>/dev/null && [ "$((applicable_n * 2))" -lt "$cloned" ]; then
    add_reason "cannot tell: only ${applicable_n} of ${cloned} cloned repos judged applicable (under the 50% floor, a scope collapse)"
  fi
  [ "${unreadable:-0}" -gt 0 ] && add_reason "cannot tell: ${unreadable} line(s) reported an unreadable repo"
  [ "$rc" = "2" ] && add_reason "cannot tell: --check exited 2"
  case "$rc" in 0|1|2) ;; *) add_reason "cannot tell: --check exited ${rc}" ;; esac
  [ "$checked_n" -eq 0 ] && add_reason "cannot tell: zero satellites checked"

  # ---- drift detail: what a round fixes vs what needs a hand edit ----
  fixable=$(grep -E '^[^[:space:]]+ +DRIFTED' "$clean" || true)
  handedit=$(grep -iE 'will NOT fix|by hand|reconcile the copies|no caller anywhere|UNWIRED' "$clean" || true)
  # Per-repo / per-entry findings the generic text above does not name:
  # overridesFloor `MISSING <repo> missing: <keys>` and the mustBeUniform /
  # keyMustBeUniform `WORSENED <path|key> ...` lines.
  perrepo=$(grep -E '^[[:space:]]+(MISSING|WORSENED)[[:space:]]' "$clean" || true)
  if [ -n "$perrepo" ]; then
    if [ -n "$handedit" ]; then handedit="${handedit}
${perrepo}"; else handedit="$perrepo"; fi
  fi
  [ -n "$fixable" ] && detail="${detail}**A delivery round fixes these (sync PRs):**

\`\`\`
${fixable}
\`\`\`

"
  [ -n "$handedit" ] && detail="${detail}**Needs a hand edit (a round will not fix these):**

\`\`\`
${handedit}
\`\`\`

"

  # --check exits 1 for problems with no DRIFTED line (missing overrides,
  # unwired guards, mustBeUniform): a round cannot fix them, so never green.
  if [ "$rc" = "1" ] && [ "$drifted_n" -eq 0 ]; then
    add_reason "--check exited 1 with no drifted satellite: needs a hand edit (a round will not fix it); see the hand-edit list"
  fi

  # ---- delivery ----
  if [ "$drifted_n" -gt 0 ]; then
    case "$delivery" in
      success) ;;
      *) add_reason "the delivery round (shared-sync.sh --now) did not succeed (outcome: ${delivery})" ;;
    esac
  fi

  # ---- stuck: a drifted satellite whose sync PR is older than the threshold ----
  if [ "$drifted_n" -gt 0 ] && [ "$delivery" = "success" ]; then
    limit=$((STUCK_HOURS * 3600))
    for name in $drifted_names; do
      url=$(git -C "${ESTATE:-.}/$name" remote get-url origin 2>/dev/null || true)
      slug=$(printf '%s' "$url" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')
      if [ -z "$slug" ]; then
        add_reason "cannot tell: no origin slug for drifted repo ${name}"
        continue
      fi
      if ! created=$(gh pr list --repo "$slug" --head chore/sync-shared --state open \
          --json createdAt --jq '.[0].createdAt // empty' 2>/dev/null); then
        add_reason "cannot tell: could not read ${slug}'s sync PRs"
        continue
      fi
      if [ -z "$created" ]; then
        pr_lines="${pr_lines}- ${slug}: no open sync PR (see the hand-edit list above)
"
        continue
      fi
      created_s=$(date -u -d "$created" +%s 2>/dev/null || echo "")
      if [ -z "$created_s" ]; then
        add_reason "cannot tell: unparseable PR date for ${slug}: ${created}"
        continue
      fi
      age=$((now_s - created_s))
      if [ "$age" -gt "$limit" ]; then
        add_reason "${slug}: drift older than ${STUCK_HOURS}h -- its sync PR (open since ${created}) is stuck"
        stuck_lines="${stuck_lines}- ${slug}: sync PR open since ${created} (stuck)
"
      else
        pr_lines="${pr_lines}- ${slug}: sync PR open since ${created}
"
      fi
    done
  fi
fi

echo "$denom"

if [ "$red" -eq 1 ]; then verdict="RED"; else verdict="GREEN"; fi
body="${MARKER}
\`${denom}\`

**Verdict: ${verdict}**
"
[ -n "$reasons" ] && body="${body}
Why:

${reasons}"
[ -n "$pr_lines" ] && body="${body}
Sync PRs:

${pr_lines}"
[ -n "$stuck_lines" ] && body="${body}
${stuck_lines}"
[ -n "$detail" ] && body="${body}
${detail}"
body="${body}
Run: ${RUN_URL:-(unknown)}

shared-sync is delivered by this workflow (\`shared-sync.sh --now\`); the fleet merges the sync PRs it opens. This issue is never auto-closed (AGENTS.md section 4). If you close it while the report is still true, the next run reopens this same issue instead of filing a new one."

printf '### Shared-sync report (%s)\n\n%s\n' "$verdict" "$body" >> "$SUMMARY_FILE"

# ---- issue routing: nothing to say when clean and green ----
if [ "$red" -eq 0 ] && [ "$drifted_n" -eq 0 ]; then
  echo "clean: no issue"
  exit 0
fi

repo_args=()
[ -n "${GITHUB_REPOSITORY:-}" ] && repo_args=(--repo "$GITHUB_REPOSITORY")
export GH_TOKEN="${ISSUE_GH_TOKEN:-${GH_TOKEN:-}}"

if ! issues=$(gh issue list "${repo_args[@]}" --state all --limit 200 --json number,state,title,body); then
  echo "could not list issues" >&2
  exit 1
fi
# Prefer the marker; fall back to the exact legacy title. Newest first.
found=$(printf '%s' "$issues" | jq -r --arg m "$MARKER" --arg t "$TITLE" '
  (map(select((.body // "") | contains($m))) | sort_by(-.number) | .[0]) //
  (map(select(.title == $t)) | sort_by(-.number) | .[0]) // empty
  | "\(.number) \(.state)"')

if [ -z "$found" ]; then
  gh issue create "${repo_args[@]}" --title "$TITLE" --body "$body" || exit 1
else
  num=${found% *}
  state=${found#* }
  if [ "$state" = "CLOSED" ]; then
    gh issue reopen "${repo_args[@]}" "$num" || exit 1
    body="Reopened: the report is still true.

${body}"
  fi
  gh issue comment "${repo_args[@]}" "$num" --body "$body" || exit 1
fi

[ "$red" -eq 1 ] && exit 1
exit 0
