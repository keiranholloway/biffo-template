#!/usr/bin/env sh
#
# Is anyone already working this issue? Ask git, not a label.
#
# ## Why this exists
#
# Several agent sessions run against this estate at once, and on 2026-08-03
# **four** of them collided in one morning:
#
#   - #1165 — another session built AND MERGED a PR for it while this one was
#     claiming it. Three minutes, start to merge.
#   - #1174 — a live worktree on `fix/1174-…` existed; the issue was unlabelled.
#   - #621, #956 — live worktrees, no labels. Labelled on their behalf.
#   - #1188 — the reverse: a label with no work, while another session built it
#     and opened a PR.
#
# Three of the four were "work exists, label does not". That is the shape this
# script is for.
#
# ## The rule it encodes
#
# **The `in-progress` label is a hand-maintained second copy of something git
# already knows.** A branch exists. A PR exists. Those are automatic — you
# cannot do the work without creating them — whereas the label is a separate
# action a human or agent has to remember, in a workflow that may never have
# been told to. Second copies of a decision drift; this estate says so about
# `_extract_detail`, about AGENTS.md, and about the commit-msg type list.
#
# So this checks FOUR signals and reports all of them, rather than trusting the
# one that is easiest to forget.
#
# ## What it cannot do
#
# Prevent a race. GitHub has no locking, two sessions can start in the same
# second, and #1165 went from branch to merged in three minutes — no protocol
# would have caught that. The goal is early, cheap detection, not exclusion.
# Every collision that morning was caught before duplicate work merged; the
# cost was minutes, not shipped rework.
#
# ## Usage
#
#   sh scripts/claim.sh 1234 --as <token>            # check, and claim if free
#   sh scripts/claim.sh 1234 --as <token> --check    # report only, change nothing
#   sh scripts/claim.sh 1234 --as <token> -R owner/repo
#   sh scripts/claim.sh 1234 --release <token>       # only the holder may clear it
#   sh scripts/claim.sh --guard <branch>             # pre-push gate — see below
#
#   0  free — and claimed, unless --check
#   1  taken, or already closed — the reason is printed
#   2  cannot tell — issue unreadable, gh unauthenticated, or no --as token
#
# 2 is deliberately not 0, matching `wait-for-checks.sh` and `branch-health.sh`.
# A check that cannot see its input must not report "free".
#
# Requires `gh`, authenticated. Uses gh's embedded jq, so no jq binary needed.
#
# ## `--as <token>` is REQUIRED on the claim and `--check` paths (#1562)
#
# It used to be optional, and `${HOLDER:+ …}` in the claim comment simply
# omitted the slug when it was absent — no flag, no slug, no warning, exit 0.
# So the safe form existed and nothing steered anyone to it: measured on
# 2026-08-13, `--as` appeared **zero** times in the AGENTS.md of every satellite
# in the estate, because the flag shipped in #1279 reached the template's own
# ruleset and neither skeleton. Two concurrent sessions in one plugin repo then
# produced four claims that read `Claimed at … by \`Keiran Holloway\`` and could
# not be told apart — ownership had to be reconstructed from a local command log,
# and for one pair could not be established at all.
#
# An optional flag that records the deciding information is a fail-open: the
# default loses exactly what the mechanism exists to keep. So a claim that
# cannot be proved to be yours is now refused rather than made.
#
# **`--guard` and `--release` are deliberately exempt.** `--guard` is invoked by
# `.githooks/pre-push` on EVERY push in every repo, with no token and no issue
# argument, and it never compares identity by design (see below) — requiring one
# there would break `git push` estate-wide to enforce a rule that path does not
# use. `--release` carries the token in its own value, so it already cannot run
# untokened.
#
# **The token must identify a session, not a role.** A mandatory field that
# everybody satisfies with `--as agent` is worse than an optional one, because it
# manufactures a column that looks authoritative and distinguishes nobody — the
# 2026-08-13 measurement above is what that looks like. So the shape is checked
# (at least two `-`-separated parts, 6+ characters), and the refusal prints a
# ready-made suggestion derived from the branch — which is already unique per
# unit of work — so the cheapest thing to type is also a good token.
#
# ## `--guard <branch>` — the pre-push gate (#1231 instance 2)
#
# The four-signal check above is advisory: nothing ever runs it for you, so a
# collision happens precisely when someone does not think to check. `--guard`
# is the enforced half, called from `.githooks/pre-push` on every push.
#
# It answers a narrower question than the plain form above, on purpose:
#
#   - **Derives the issue from the branch name.** Pattern `<type>/<number>-…`,
#     e.g. `feat/1234-thing`. A branch that does not name an issue (most of
#     them) is skipped SILENTLY, before any network call — most branches are
#     fine and noise kills a gate.
#   - **Never checks the `in-progress` label.** Of four real collisions in one
#     morning, three were "work exists, label does not" — so a gate keyed on
#     the label would have caught one of four. This checks only what git and
#     GitHub cannot help but know: an open PR, a remote branch.
#   - **Never compares identity.** A claim on #1109 was recorded as
#     `github-actions[bot]` because of a repo-local `user.email` override —
#     usernames are not a trustworthy signal here.
#   - **Excludes the branch being pushed, and any PR whose head IS that
#     branch**, from counting as a conflict. Without this, pushing your own
#     branch a second time blocks you on your own work.
#   - **A real conflict — another branch or another open PR naming the same
#     issue — exits 1**, naming what was found. AGENTS.md permits stealing a
#     claim that is over an hour stale, with a comment; the message points
#     there rather than being a dead end.
#   - **"Cannot tell" (no network, `gh` unauthenticated, an API error) warns
#     and exits 2 — never 1.** By default the caller should treat 2 as a pass:
#     this is a COORDINATION gate, not a correctness one, and a false block
#     costs the ability to push at all while a miss costs a recoverable
#     collision caught early (see "What it cannot do" above). Set
#     `BIFFO_CLAIM_STRICT=1` to make this script itself collapse cannot-tell
#     into exit 1 instead, for anyone who would rather block than guess.

set -u

ISSUE=""
REPO=""
HOLDER=""
RELEASE=""
HOLDER_MARK="claim-holder:"
CHECK_ONLY=""
GUARD_BRANCH=""

usage() {
  # The whole header comment, found rather than hardcoded: the previous fixed
  # `2,84p` was already truncating the last five lines of the `--guard` section
  # mid-sentence, and any edit to the header silently moves where the real end
  # is. Derived from `set -u`, which is always the first line of code.
  _usage_end=$(grep -n '^set -u' "$0" | head -1 | cut -d: -f1)
  sed -n "2,$((_usage_end - 2))p" "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

# Colours are needed inside the parse loop below (a missing-value message),
# so they are defined before it rather than after.
RED=$(printf '\033[31m')
GREEN=$(printf '\033[32m')
YELLOW=$(printf '\033[33m')
DIM=$(printf '\033[90m')
OFF=$(printf '\033[0m')

# A flag that takes a value must not blindly `shift 2`: with exactly one
# argument left -- the flag itself, nothing after it -- that shifts past the
# end of `$@` (#826). `shift` is a POSIX SPECIAL builtin, and dash (the real
# `sh` on this workstation, and on every machine this ships to) aborts the
# WHOLE SCRIPT on a special builtin's error, non-interactively, before a
# single line of this script's own handling runs -- printing dash's own
# "shift: can't shift that many" and exiting 2 by dash's choice, not this
# script's. bash instead treats the overflowing `shift` as a silent no-op:
# `$1` never changes, so `while [ $# -gt 0 ]` spins forever. Neither behaviour
# was ever something this script decided; both were found by running the
# actual failing command, under the actual interpreter, not by reasoning
# about `shift` from memory.
missing_value() {
  echo "${RED}claim: $1 requires a value${OFF}" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    -R | --repo)
      [ $# -ge 2 ] || missing_value "$1"
      REPO="$2"
      shift 2
      ;;
    --check) CHECK_ONLY=1; shift ;;
    --as)
      [ $# -ge 2 ] || missing_value "$1"
      HOLDER="$2"
      shift 2
      ;;
    --release)
      # No bounds check here on purpose. A bare trailing `--release` (no
      # token) is not a generic usage error like the flags above -- it is
      # the exact place AGENTS.md's own FIRST documented form, the untokened
      # `claim <issue>`, leads a session that later wants to release what it
      # claimed. It gets its own deliberate refusal below (a missing token
      # is a definite "no", not a malformed invocation), not this generic
      # "$flag requires a value" message.
      RELEASE=1
      if [ $# -ge 2 ]; then
        HOLDER="$2"
        shift 2
      else
        shift
      fi
      ;;
    --guard)
      [ $# -ge 2 ] || missing_value "$1"
      GUARD_BRANCH="$2"
      shift 2
      ;;
    -h | --help) usage ;;
    *)
      ISSUE="$1"
      shift
      ;;
  esac
done

gh_issue() { if [ -n "$REPO" ]; then gh issue "$@" --repo "$REPO"; else gh issue "$@"; fi; }
gh_pr() { if [ -n "$REPO" ]; then gh pr "$@" --repo "$REPO"; else gh pr "$@"; fi; }
gh_label() { if [ -n "$REPO" ]; then gh label "$@" --repo "$REPO"; else gh label "$@"; fi; }

# Does the newest claim comment on $1 carry holder token $2? (#1279)
#
# Reads the LAST claim comment rather than any, so a re-claim by a different
# session supersedes an older one rather than both matching for ever. Returns
# non-zero when it cannot tell -- an unreadable comment list must never read as
# "yours", or the flag becomes a way to steal a claim by guessing.
#
# Requires $2 non-empty (#826): the match below is `*"$HOLDER_MARK$2"*`, and
# with $2 empty that collapses to `*"claim-holder:"*` -- true of ANY comment
# naming ANY holder at all, regardless of whose. An empty token must never
# read as "matches every claim"; it is refused explicitly, before the network
# call this would otherwise spend.
claim_held_by() {
  [ -n "$2" ] || return 1
  _c=$(gh_issue view "$1" --json comments \
    --jq "[.comments[]? | select(.body | contains(\"$HOLDER_MARK\"))] | last | .body // \"\"" \
    2>/dev/null) || return 1
  [ -n "$_c" ] || return 1
  case "$_c" in
    *"$HOLDER_MARK$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

# This repo as `owner/name`, so a closing reference can be checked against it.
# GitHub records a CROSS-REPO closing reference in the same list as a local one
# -- tabsii-lms#43 closes tabsii-platform#553 -- so the number alone is not an
# answer, and matching on it reproduces the very defect this replaces (#1281).
#
# Resolved LAZILY, on first use. Computing it at load cost a `gh repo view` on
# every single push, including the overwhelmingly common case where `--guard`
# skips silently because the branch names no issue -- a guard that is meant to
# touch nothing was suddenly making a network call per push.
SLUG=""
SLUG_RESOLVED=""
repo_slug() {
  if [ -z "$SLUG_RESOLVED" ]; then
    SLUG_RESOLVED=1
    if [ -n "$REPO" ]; then
      SLUG="$REPO"
    else
      SLUG=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "")
    fi
  fi
  printf '%s' "$SLUG"
}

# `git ls-remote --heads ""` fails outright ("fatal: bad repository ''") rather
# than falling back to the default remote — `${REPO:+url}` expands to an empty
# STRING ARGUMENT when $REPO is unset, not to no argument at all. That silently
# broke signal 3 below for every caller that does not pass -R, which is nearly
# all of them: the branch check never fired, and nothing noticed because the
# label and open-PR signals usually catch a collision first. Found while
# building `--guard`, which depends on this signal actually working.
remote_branches() {
  if [ -n "$REPO" ]; then
    git ls-remote --heads "https://github.com/$REPO.git"
  else
    git ls-remote --heads
  fi
}

# --- the structural claim predicate (#1411, class #1362 instance 8) ---------
#
# "Does this open PR claim issue $1?" used to be answered independently at
# THREE call sites -- the `--guard` open-PR check, the plain-path open-PR
# check, and (before #1281/#1311) a fourth that scanned body text for any
# mention at all. Three copies of one question drift, which is exactly how
# this class keeps recurring (#1281, #1311, #1327 were all this same guard,
# fixed three separate times). This is now the ONE place the question is
# answered, called from both surviving sites.
#
# Emits the boolean body of a jq `select(...)` over a PR object carrying
# `number`/`headRefName`/`closingIssuesReferences`/`body`. Three signals, and
# each one is either GitHub's own structured answer or this estate's own
# documented convention -- never a bare "does the text mention #N anywhere"
# scan, which is what #1327 and #1311 both were:
#
#   1. `closingIssuesReferences` -- GitHub's OWN parse of a recognised closing
#      keyword (Closes/Fixes/Resolves and their inflections). Authoritative;
#      never re-derived by a regex here.
#   2. the branch name (`<type>/<number>-slug`), the same test used
#      elsewhere in this file.
#   3. the PR body, but ONLY AGENTS.md's own `Refs #N` convention -- the form
#      this estate mandates for a PR that must reference an issue WITHOUT
#      closing it (DDL PRs, "instance of a class" PRs like this one). A
#      claiming keyword (`refs`/`ref`/`references`/`reference`, case
#      insensitive) must be immediately followed by `#N` on the SAME LINE.
#      `\s` matches a newline, which is precisely the shape #1334 found in
#      GitHub's own closing-keyword parser (a keyword ending one line, `#N`
#      starting the next); this uses `[ \t]` instead, so a keyword and a
#      reference split across a line break -- or a bare mention of `#N` with
#      no keyword at all -- cannot match. A prose sentence like "this does
#      NOT claim #N" carries no claiming keyword adjacent to the `#N` and so
#      correctly does not match either (#1327, #1311's exact shape).
#
# $2 is the repo slug (`owner/name`) the closing-reference check compares
# against -- callers already resolve this via `repo_slug()` before calling.
claim_select_expr() {
  _n="$1"
  _slug="$2"
  printf '(([.closingIssuesReferences[]? | select(.number == %s and ((.repository.owner.login + "/" + .repository.name) == "%s"))] | length > 0) or (.headRefName | test("(^|[^0-9A-Za-z])%s([^0-9A-Za-z]|$)")) or ((.body // "") | test("(^|[^0-9A-Za-z])(refs?|references?)[ \\t]*:?[ \\t]*#%s([^0-9A-Za-z]|$)"; "i")))' \
    "$_n" "$_slug" "$_n" "$_n"
}

LABEL=in-progress

# --- holder identity (#1279) -------------------------------------------------
#
# A claim used to record WHEN and WHO, and every session on a workstation claims
# under the same GitHub actor. So a delegated agent could not distinguish
# "my orchestrator claimed this for me" from "a stranger claimed it 90 seconds
# ago", and the safe reading is to stop. On 2026-08-04 four agents were
# dispatched onto pre-claimed issues; one ran the check first and correctly
# refused to start, producing nothing. Whether a delegate works or stalls
# depended on whether it happened to check before starting.
#
# `--as <token>` makes the claim answerable: an existing claim carrying the same
# token reads as YOUR claim and returns free. `--release <token>` refuses to
# clear somebody else's.
#
# The token is opaque and never a secret -- it identifies a session, not a
# person, and appears in a public comment.

TAKEN=0
REASONS=""

note() { REASONS="${REASONS}  $1\n"; TAKEN=1; }

# --- --release <token>: only the holder clears it (#1279) --------------------
#
# A claim nobody can prove ownership of is one anybody can clear, and a stale
# label left behind by a crashed session is indistinguishable from a live one.
# Refusing a mismatched release is what makes the token worth recording.
if [ -n "$RELEASE" ]; then
  # A missing token (#826) is a definite "no", not a malformed invocation —
  # AGENTS.md's own first documented `claim <issue>` form never records one,
  # so this is the ordinary route a session that skipped `--as` takes when it
  # tries to release later, not a typo. Decided here rather than falling into
  # `claim_held_by`'s ordinary mismatch branch below: without this, an empty
  # $HOLDER would either (pre-#826-hardening) match ANY held claim via a
  # substring accident, or now correctly fail but with a message talking
  # about "not held by ''", which explains nothing. This says plainly what is
  # wrong and what to do about it, and reuses the SAME refusal exit code (1)
  # as an ordinary token mismatch just below — it is that case's degenerate
  # form, not a new kind of outcome, so it does not invent a third code.
  if [ -z "$HOLDER" ]; then
    echo "${RED}claim: --release needs the token you claimed with (--release <token>).${OFF}" >&2
    echo "${DIM}  Claimed without --as? There is no token to prove ownership by, so this${OFF}" >&2
    echo "${DIM}  script cannot tell it is you. Release it by hand instead:${OFF}" >&2
    echo "${DIM}    gh issue edit $ISSUE --remove-label $LABEL${OFF}" >&2
    exit 1
  fi
  if claim_held_by "$ISSUE" "$HOLDER"; then
    gh_issue edit "$ISSUE" --remove-label "$LABEL" >/dev/null 2>&1 || {
      echo "${RED}claim: could not remove the '$LABEL' label.${OFF}" >&2
      exit 2
    }
    echo "${GREEN}Released.${OFF} ${DIM}(held by $HOLDER)${OFF}"
    exit 0
  fi
  echo "${RED}claim: #$ISSUE is not held by '$HOLDER' — refusing to release it.${OFF}" >&2
  echo "${DIM}  Clearing somebody else's claim is how two sessions end up on one issue.${OFF}" >&2
  echo "${DIM}  If the claim is genuinely stale (AGENTS.md: over an hour, no branch, no PR),${OFF}" >&2
  echo "${DIM}  remove the label by hand and say so in a comment.${OFF}" >&2
  exit 1
fi


# --- --guard <branch>: the enforced pre-push gate -----------------------------
#
# Deliberately short-circuits before any of the four-signal machinery below —
# it asks two of those four questions, not all four, and answers a different
# question ("would this push collide with someone else's live work?" rather
# than "is this issue free to claim?").
if [ -n "$GUARD_BRANCH" ]; then
  guard_issue=$(printf '%s' "$GUARD_BRANCH" | sed -n 's#^[^/]*/\([0-9][0-9]*\)-.*#\1#p')

  # No issue named by the branch — most branches, e.g.
  # `security/brace-expansion-5-0-9`. Skip silently, and — this is the point —
  # before touching the network at all.
  if [ -z "$guard_issue" ]; then
    exit 0
  fi

  cannot_tell=0
  conflict=0
  findings=""
  cannot_tell_reasons=""

  # --- an open PR referencing the issue, excluding our own branch's PR --------
  slug=$(repo_slug)
  pr_err=$(mktemp)
  select_expr=$(claim_select_expr "$guard_issue" "$slug")
  open_prs=$(gh_pr list --state open --limit 100 --json number,headRefName,closingIssuesReferences,body \
    --jq "[.[] | select($select_expr)] | .[] | select(.headRefName != \"$GUARD_BRANCH\") | \"#\(.number) \(.headRefName)\"" \
    2>"$pr_err")
  pr_status=$?
  pr_err_text=$(cat "$pr_err")
  rm -f "$pr_err"

  if [ "$pr_status" -ne 0 ]; then
    cannot_tell=1
    cannot_tell_reasons="${cannot_tell_reasons}${pr_err_text} "
  elif [ -n "$open_prs" ]; then
    conflict=1
    findings="${findings}  ${RED}open PR${OFF}    $(printf '%s' "$open_prs" | head -1)\n"
  fi

  # --- a remote branch naming the issue, excluding our own branch -------------
  branch_err=$(mktemp)
  raw_branches=$(remote_branches 2>"$branch_err")
  branch_status=$?
  branch_err_text=$(cat "$branch_err")
  rm -f "$branch_err"

  if [ "$branch_status" -ne 0 ]; then
    cannot_tell=1
    cannot_tell_reasons="${cannot_tell_reasons}${branch_err_text} "
  else
    other_branch=$(printf '%s\n' "$raw_branches" |
      sed 's|.*refs/heads/||' |
      grep -E "(^|[^0-9A-Za-z])$guard_issue([^0-9A-Za-z]|$)" |
      grep -v -x "$GUARD_BRANCH" | head -1)
    if [ -n "$other_branch" ]; then
      conflict=1
      findings="${findings}  ${RED}branch${OFF}     $other_branch\n"
    fi
  fi

  if [ "$conflict" -eq 1 ]; then
    printf '%b' "${RED}claim --guard: issue #$guard_issue looks claimed by someone else.${OFF}\n$findings"
    echo
    echo "${DIM}If you believe it is abandoned (no activity for over an hour), AGENTS.md${OFF}"
    echo "${DIM}permits stealing it deliberately — say so in a comment on the issue first,${OFF}"
    echo "${DIM}then push. Never steal a fresh claim.${OFF}"
    exit 1
  fi

  if [ "$cannot_tell" -eq 1 ]; then
    if [ -n "${BIFFO_CLAIM_STRICT:-}" ]; then
      echo "${RED}claim --guard: cannot tell whether #$guard_issue is claimed elsewhere${OFF} — ${DIM}$cannot_tell_reasons${OFF}" >&2
      echo "${DIM}BIFFO_CLAIM_STRICT=1 is set, so cannot-tell blocks the push.${OFF}" >&2
      exit 1
    fi
    echo "${YELLOW}claim --guard: cannot tell whether #$guard_issue is claimed elsewhere${OFF} — ${DIM}$cannot_tell_reasons${OFF}" >&2
    echo "${DIM}Warning and letting the push through: this is a coordination gate, not a${OFF}" >&2
    echo "${DIM}correctness one. Set BIFFO_CLAIM_STRICT=1 to block instead of guessing.${OFF}" >&2
    exit 2
  fi

  exit 0
fi

case "$ISSUE" in
  '' | *[!0-9]*)
    echo "claim: give an issue number, e.g. sh scripts/claim.sh 1234 --as <token>" >&2
    exit 2
    ;;
esac

# --- --as <token> is required from here on (#1562) ---------------------------
#
# Placed AFTER the `--guard` and `--release` short-circuits above, which is the
# whole exemption: those two paths exit before reaching this line. Everything
# below is the four-signal check and the claim it writes — the two things that
# need to know whose session is asking.
#
# A suggestion, not a lecture. An agent that hits this must be able to fix it by
# copying one line, so the refusal derives a token instead of describing one:
#
#   <slug>-<MMDD>-<pid>
#
# `<slug>` comes from the current branch when it names the work, because a
# branch is already unique per unit of work (AGENTS.md: one worktree per unit).
# Claiming usually happens BEFORE the worktree exists, though — you claim from
# the primary checkout, on `dev` — so on an integration branch the slug falls
# back to the issue, and the pid keeps two sessions that both did that apart.
suggest_token() {
  _b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')
  case "$_b" in
    '' | HEAD | dev | main | master | staging) _slug="issue$ISSUE" ;;
    */*) _slug=$(printf '%s' "${_b#*/}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | cut -c1-24) ;;
    *) _slug=$(printf '%s' "$_b" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | cut -c1-24) ;;
  esac
  _slug=$(printf '%s' "$_slug" | sed 's/-*$//')
  printf '%s-%s-%04x' "$_slug" "$(date -u +%m%d)" "$$"
}

# Two `-`-separated parts, 6+ characters. Deliberately shape-only: the token is
# opaque by design, so there is nothing else to validate — but `agent`, `me`,
# `bot`, `session` and every other role word a whole estate would share fail it,
# and that is the failure this rule is for. See the header.
token_is_identifying() {
  case "$1" in
    *[!A-Za-z0-9._-]*) return 1 ;; # opaque-token characters only
    -* | *-) return 1 ;;           # no leading or trailing separator
    *-*) [ "${#1}" -ge 6 ] ;;      # two parts, long enough to be a session
    *) return 1 ;;                 # a single word: 'agent', 'bot', 'me'
  esac
}

if [ -z "$HOLDER" ]; then
  _s=$(suggest_token)
  echo "${RED}claim: --as <token> is required.${OFF}" >&2
  echo "${DIM}  A claim with no token cannot be proved to be yours: every session on this${OFF}" >&2
  echo "${DIM}  workstation claims under the same GitHub actor, so --release has nothing to${OFF}" >&2
  echo "${DIM}  check and a delegated agent cannot tell your reservation from a stranger's.${OFF}" >&2
  echo >&2
  echo "  sh scripts/biffo.sh claim $ISSUE --as $_s" >&2
  echo >&2
  echo "${DIM}  Give that same token to every agent you dispatch onto #$ISSUE, and release it${OFF}" >&2
  echo "${DIM}  with:  sh scripts/biffo.sh claim $ISSUE --release $_s${OFF}" >&2
  exit 2
fi

if ! token_is_identifying "$HOLDER"; then
  _s=$(suggest_token)
  echo "${RED}claim: --as '$HOLDER' does not identify a session.${OFF}" >&2
  echo "${DIM}  Needs two '-'-separated parts and 6+ characters, e.g. <what>-<MMDD>-<unique>.${OFF}" >&2
  echo "${DIM}  A token every session shares — 'agent', 'bot', 'me' — is worse than none:${OFF}" >&2
  echo "${DIM}  it fills the field that decides ownership with a value that decides nothing.${OFF}" >&2
  echo >&2
  echo "  sh scripts/biffo.sh claim $ISSUE --as $_s" >&2
  exit 2
fi

# --- 0. Does the issue exist, and is it still open? --------------------------

meta=$(gh_issue view "$ISSUE" --json state,title,labels \
  --jq '"\(.state)\t\(.title)\t\((.labels|map(.name)|join(",")))"' 2>/dev/null) || {
  echo "${RED}claim: cannot read issue #$ISSUE${OFF} — wrong repo, or gh not authenticated." >&2
  echo "${DIM}  That is 'cannot tell', not 'free'.${OFF}" >&2
  exit 2
}

state=$(printf '%s' "$meta" | cut -f1)
title=$(printf '%s' "$meta" | cut -f2)
labels=$(printf '%s' "$meta" | cut -f3)

echo "${DIM}#$ISSUE — $title${OFF}"
echo

if [ "$state" != "OPEN" ]; then
  echo "${RED}Already $state.${OFF} Nothing to claim."
  exit 1
fi

# --- 1. The label. Easiest to check, easiest to forget. ----------------------

case ",$labels," in
  *",$LABEL,"*)
    updated=$(gh_issue view "$ISSUE" --json updatedAt --jq .updatedAt 2>/dev/null)
    # Whose claim is it? (#1279) A claim carrying OUR token is not a collision --
    # it is the orchestrator that dispatched us. Without this a delegated agent
    # cannot tell its own reservation from a stranger's and correctly refuses to
    # start, which is the failure this flag exists to remove.
    if [ -n "$HOLDER" ] && claim_held_by "$ISSUE" "$HOLDER"; then
      echo "${DIM}label      carries '$LABEL', held by ${HOLDER} — that is you${OFF}"
    else
      note "${YELLOW}label${OFF}      carries '$LABEL' (issue last updated $updated)"
    fi
    ;;
esac

# --- 2. An open PR that references it ----------------------------------------
#
# The strongest signal, because a PR cannot be opened without the work existing.
# Uses `claim_select_expr` (above) -- the same structural predicate the
# `--guard` path uses -- so a `Closes #N`, a branch naming N, or a `Refs #N`
# (this estate's own convention for a PR that must not close its issue, e.g.
# a DDL PR) are all detected identically in both places, and a bare mention of
# `#N` in prose is not (#1281, #1311, #1327; #1411 is the `Refs` gap).

slug=$(repo_slug)
select_expr=$(claim_select_expr "$ISSUE" "$slug")
open_prs=$(gh_pr list --state open --limit 100 --json number,headRefName,closingIssuesReferences,body \
  --jq "[.[] | select($select_expr)] | .[] | \"#\(.number) \(.headRefName)\"" 2>/dev/null)

if [ -n "$open_prs" ]; then
  printf '%s\n' "$open_prs" | while IFS= read -r pr; do
    [ -n "$pr" ] && echo "  ${RED}open PR${OFF}    $pr"
  done
  note "${RED}open PR${OFF}    see above — someone has working code"
fi

# --- 3. A remote branch naming it --------------------------------------------
#
# Catches work that has been pushed but has no PR yet. Whole-number match
# again — and "whole number" means bounded by a NON-ALPHANUMERIC character on
# both sides, not just a non-digit. `[^0-9]` alone let a letter sit directly
# against the digit: `docs/h3-tabsii-strict-restored` (a real branch, from the
# H3 strict-branch-protection experiment) matched issue #3, because "h" is not
# a digit either. Reproduced against a clean `origin/dev` clone with zero
# relation to the branch under test — this is a live false-positive, not a
# fixture artefact — and confirmed via `cli/src/lib/claim-structured-refs.test.ts`
# ("a CROSS-REPO closing reference with the same number does not claim it"),
# whose own git-remote-backed fixture happened to expose it. `[^0-9A-Za-z]`
# requires an actual word boundary, matching the branch-naming convention
# (`<type>/<number>-<slug>`, where the character before the number is always
# `/`, never a letter) — so `h3` no longer matches `3`, while `feat/1234-x`
# still matches `1234`. Same fix applied to the three other whole-number
# matches in this file (the `--guard` path's PR and branch checks above, and
# the normal path's PR check below) — all four shared the identical pattern.

branches=$(remote_branches 2>/dev/null |
  sed 's|.*refs/heads/||' |
  grep -E "(^|[^0-9A-Za-z])$ISSUE([^0-9A-Za-z]|$)" 2>/dev/null)

if [ -n "$branches" ]; then
  printf '%s\n' "$branches" | while IFS= read -r b; do
    [ -n "$b" ] && echo "  ${RED}branch${OFF}     $b"
  done
  note "${RED}branch${OFF}     a remote branch names this issue"
fi

# --- 4. A recently merged PR that already closed it --------------------------
#
# Not "taken" — "possibly already done". #1165 was built and merged in three
# minutes; the only trace afterwards is a merged PR.

slug=$(repo_slug)
merged=$(gh_pr list --state merged --limit 30 --json number,mergedAt,closingIssuesReferences \
  --jq "[.[] | select(([.closingIssuesReferences[]? | select(.number == $ISSUE and ((.repository.owner.login + \"/\" + .repository.name) == \"$slug\"))] | length > 0))] | .[0] | select(. != null) | \"#\(.number) merged \(.mergedAt[0:16])\"" 2>/dev/null)

if [ -n "$merged" ]; then
  echo "  ${YELLOW}merged${OFF}     $merged"
  echo "  ${DIM}           the issue is still open, but work referencing it has landed —${OFF}"
  echo "  ${DIM}           read it before rebuilding.${OFF}"
fi

# --- Verdict ------------------------------------------------------------------

echo
if [ "$TAKEN" -eq 1 ]; then
  printf '%b' "${RED}Taken.${OFF} Signals:\n$REASONS"
  echo
  echo "${DIM}If you believe it is abandoned, check how old the work is and say so in a${OFF}"
  echo "${DIM}comment before taking it. Never steal a fresh claim.${OFF}"
  exit 1
fi

if [ -n "$CHECK_ONLY" ]; then
  echo "${GREEN}Free.${OFF} ${DIM}(--check: nothing changed)${OFF}"
  exit 0
fi

# Make sure the label EXISTS before trying to apply it (#1289).
#
# AGENTS.md requires this label, and nothing ever created it. It was absent in
# 12 of 16 estate repos, so `claim` could never return 0 there: the add below
# failed and the script exited 2, "cannot tell", on every issue, for ever. The
# coordination gate was structurally unable to pass in three quarters of the
# estate, and nobody noticed because the two repos where claiming is exercised
# most -- biffo-template and tabsii-platform -- were among the four that had it.
#
# Creating it here rather than in a setup step is deliberate: a label that only
# exists where somebody remembered to run something is the same defect one step
# removed. This runs on the claim path, so the mechanism repairs itself in any
# repo where it is used, including one scaffolded tomorrow.
#
# Idempotent, and NOT fatal on failure: `gh label create` exits non-zero when the
# label already exists, which is the overwhelmingly common case. A real failure
# (no permission, no network) surfaces on the add immediately below, which IS
# fatal -- so a broken claim still refuses rather than pretending.
gh_label create "$LABEL" \
  -c FBCA04 \
  -d "Claimed by a running agent session -- do not start work on this" \
  >/dev/null 2>&1 || true

# Claim it. Label AND comment together: the label is what other sessions filter
# on, the comment is what dates it so a stale claim can be recognised later, and
# the holder token is what makes it answerable.
#
# The token is interpolated unconditionally (#1562). It used to be
# `${HOLDER:+ ${HOLDER_MARK}${HOLDER}}` — present only when `--as` was passed —
# which is why a claim could be written with nothing to identify it. That branch
# is now unreachable (the requirement above exits 2 first), so the conditional
# would only be a place for the old behaviour to come back.
gh_issue edit "$ISSUE" --add-label "$LABEL" >/dev/null 2>&1 || {
  echo "${RED}claim: could not apply the '$LABEL' label.${OFF}" >&2
  echo "${DIM}  Not claimed. Do not start work on the assumption that it worked.${OFF}" >&2
  exit 2
}
gh_issue comment "$ISSUE" \
  --body "Claimed at $(date -u +%FT%TZ) by \`$(git config user.name 2>/dev/null || echo agent)\`. ${HOLDER_MARK}${HOLDER} Release it — remove the label — on merge, or if you stop." \
  >/dev/null 2>&1

echo "${GREEN}Claimed.${OFF}"
echo "${DIM}Push your branch as soon as it exists: a claim is a reservation, the branch${OFF}"
echo "${DIM}is the evidence, and the window between them is where collisions happen.${OFF}"
exit 0
