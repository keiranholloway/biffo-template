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
#   - **Never compares identity by GitHub username.** A claim on #1109 was
#     recorded as `github-actions[bot]` because of a repo-local `user.email`
#     override — usernames are not a trustworthy signal here. What #1698 adds
#     below is not a username comparison: it is the claim record's own
#     `claim-branch` field, written by `--as` at claim time, checked against
#     the branch actually being pushed.
#   - **Excludes the branch being pushed, and any PR whose head IS that
#     branch**, from counting as a conflict. Without this, pushing your own
#     branch a second time blocks you on your own work.
#   - **Excludes a SUPERSEDED PREDECESSOR** — a remote branch naming the same
#     issue whose every commit is already carried by the branch being pushed,
#     which is what a rebase leaves behind. An issue number has no lineage, so
#     the number-only comparison could not tell that branch from a rival
#     session's, and a dead predecessor blocked every later push naming the
#     issue (tabsii-com/tabsii-platform#1112). Decided from the object graph by
#     `branch_is_absorbed` below, which fails CLOSED — anything it cannot
#     positively demonstrate stays a conflict, INCLUDING a candidate carrying
#     no commits of its own. A branch sitting at `dev`'s tip is a reservation
#     (AGENTS.md asks for exactly that: "push your branch as soon as it
#     exists"), and "every commit on it is already carried" is vacuously true
#     of a branch with no commits — so without that requirement the discount
#     waved through the most ordinary rival there is. Note the discount applies
#     to the BRANCH signal only: an OPEN PR is a live claim regardless of
#     lineage and is never discounted.
#   - **The discount above is ALSO gated on the claim record (#1698).** Patch
#     equivalence alone cannot tell "my own rebase of my own predecessor" from
#     "an independent rival's rebase of the same starting point" — two sessions
#     rebasing the same predecessor onto the same tip produce identical
#     patches, with zero merge commits, and no open PR on either side for the
#     first several minutes. `branch_is_absorbed` therefore only DISCOUNTS a
#     candidate when the issue's claim record — `claim_guard_branch`, read from
#     the same durable comment `--as` already writes, never a new store —
#     names the branch being pushed as the CURRENT claim. Missing, unreadable,
#     written before this field existed, or naming a different branch: all
#     fail CLOSED into a conflict, same as an ordinary rival, with a message
#     explaining why rather than a silent pass.
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
BRANCH_MARK="claim-branch:"
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
      # A FLAG IS NOT A TOKEN. This swallowed `$2` unconditionally, so the natural
      # `--release --as <token>` set HOLDER to the literal string `--as`, and the real
      # token then fell through to the positional slot and OVERWROTE THE ISSUE NUMBER.
      #
      # The result was the message `#<token> is not held by '--as'` -- which reads as "the
      # holder does not match", not "you wrote the flags in the wrong order". Measured
      # consequence, from the fleet's own journal: agents concluded no claim could ever be
      # released, fell back to removing `in-progress` by hand, and mostly stopped bothering.
      # Claims then accumulated for days -- tabsii-platform#567 sat claimed from 08-17 to
      # 08-21 -- and every claimed issue is undispatchable, so the queue drained itself.
      #
      # `--release <token>` was always correct and always worked. The defect is that the
      # WRONG form was accepted and mangled instead of refused. Accepting both is better
      # than refusing one: `--as` already sets HOLDER, so simply not eating a flag makes
      # `--release --as <token>` work too, and neither form can misparse.
      case "${2:-}" in
        -*|'') shift ;;
        *) HOLDER="$2"; shift 2 ;;
      esac
      ;;
    --guard)
      [ $# -ge 2 ] || missing_value "$1"
      GUARD_BRANCH="$2"
      shift 2
      ;;
    -h | --help) usage ;;
    -*)
      # An unrecognized flag must never fall into the catch-all below (#1741).
      # It used to: a token that starts with `-` but matches none of the
      # cases above fell straight into `*) ISSUE="$1"; shift ;;`, so
      # `--bogus` silently became the "issue number" -- corrupting ISSUE with
      # flag text instead of the real positional argument -- and the script
      # went on to fail the `[!0-9]*` check below with "give an issue
      # number", a message that describes the SYMPTOM (ISSUE is not
      # numeric) and hides the actual CAUSE (an unsupported flag was typed).
      # Refusing here, at the point the flag is actually unrecognized, says
      # what is really wrong instead of a confusing knock-on error.
      echo "${RED}claim: unrecognized flag '$1'${OFF}" >&2
      echo "${DIM}  Known flags: -R/--repo, --check, --as, --release, --guard, -h/--help.${OFF}" >&2
      exit 2
      ;;
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
# session supersedes an older one rather than both matching for ever.
#
# TRI-STATE return, not a boolean (#1691). `gh issue view --json comments`
# failing (network, auth, wrong repo) and the comment list genuinely holding
# no claim of $2's are NOT the same fact, and collapsing both onto a single
# non-zero used to make every caller unable to tell "we don't know" from "we
# checked and it's someone else's" -- with opposite costs depending which
# side reads it: `--release` reported a definite-sounding "not held by you"
# for a claim it simply could not read, and the claim path had no way to
# refuse ONLY on genuine ambiguity without also refusing every ordinary
# non-match.
#
#   0  held by $2
#   1  determined NOT held by $2 -- the read succeeded, no match
#   2  cannot tell -- the read itself failed
#
# An unreadable comment list must never read as "yours" (a caller could steal
# a claim by guessing) and must never read as plain "not yours" either (a
# caller on the CLAIM path would then treat "cannot tell" as "free", which is
# exactly the fail-open this replaces). Every caller below must branch on all
# three values, not just truthy/falsy.
#
# Requires $2 non-empty (#826): the match below is `*"$HOLDER_MARK$2"*`, and
# with $2 empty that collapses to `*"claim-holder:"*` -- true of ANY comment
# naming ANY holder at all, regardless of whose. An empty token is a caller
# bug, not an unreadable issue, so it is refused as a definite non-match (1),
# before the network call this would otherwise spend.
claim_held_by() {
  [ -n "$2" ] || return 1
  _c=$(gh_issue view "$1" --json comments \
    --jq "[.comments[]? | select(.body | contains(\"$HOLDER_MARK\"))] | last | .body // \"\"" \
    2>/dev/null) || return 2
  [ -n "$_c" ] || return 1
  case "$_c" in
    *"$HOLDER_MARK$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

# claim_guard_branch <issue> -- tri-state read of the RECORDED branch on
# $issue's most recent claim comment (the `claim-branch:` field the write
# side below adds, #1698). Prints the branch name and returns 0 when a claim
# comment carries one; returns 1 when the comment list is readable but gives
# no confirmed branch (no claim comment at all, or one written before this
# field existed); returns 2 when the comment list itself could not be read.
#
# 1 and 2 are BOTH "not confirmed", never "confirmed free" -- the same
# fail-closed shape `claim_held_by` already uses for the holder token, for the
# same reason: a caller that collapsed them would treat an unclaimed issue or
# a flaky API call as proof nobody else is here, which is exactly the
# fail-open `--guard`'s own lineage discount shipped with (#1696) and this
# function exists to close.
claim_guard_branch() {
  _c=$(gh_issue view "$1" --json comments \
    --jq "[.comments[]? | select(.body | contains(\"$HOLDER_MARK\"))] | last | .body // \"\"" \
    2>/dev/null) || return 2
  [ -n "$_c" ] || return 1
  case "$_c" in
    *"$BRANCH_MARK"*)
      _gb_rest=${_c#*"$BRANCH_MARK"}
      _gb_branch=${_gb_rest%% *}
      [ -n "$_gb_branch" ] || return 1
      printf '%s\n' "$_gb_branch"
      return 0
      ;;
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

# What issue does $1 derive, per the `<type>/<number>-<slug>` convention,
# with leading zeros stripped -- or empty if $1 names no issue at all (#1672).
#
# ONE place both sides of a collision check go through. `--guard`'s own
# derivation used to run this pattern once for its own branch and then match
# CANDIDATE branches with a completely different technique -- a boundary-
# anchored substring search over the raw, unstripped candidate text. That
# let a zero-padded branch (`feat/0010-x`) go unmatched against an identical
# zero-padded sibling (`feat/0010-y`), because the search side had been
# stripped to `10` and `10` cannot match inside literal `0010` at a boundary
# (the character before it is `0`, itself alphanumeric). Deriving BOTH sides
# through this one function and comparing the two normalised numbers, rather
# than searching for one inside the other's text, removes the asymmetry
# structurally: whatever stripping happens to the target happens identically
# to the candidate. It is also deliberately narrower than a bare substring
# search -- `dm-04` and `104` carry no `/`, so nothing is derived from them,
# which is what keeps a bare `4` from colliding with either.
derive_branch_issue() {
  _dbi_n=$(printf '%s' "$1" | sed -n 's#^[^/]*/\([0-9][0-9]*\)-.*#\1#p')
  [ -n "$_dbi_n" ] || return 0
  printf '%s' "$_dbi_n" | sed 's/^0*\([0-9]\)/\1/'
}

# --- lineage: is remote branch tip $1 already carried by local branch $2? -----
#
# The branch check below compares ISSUE NUMBERS, and a number has no lineage.
# So it could not tell a genuine RIVAL CLAIMANT -- another session working the
# same issue -- from the pusher's OWN SUPERSEDED PREDECESSOR, the branch they
# abandoned and rebased away from. Measured live on tabsii-platform:
# `fix/1050-1033-1061-upstream-carry` is still on the remote at 5b1b8977 while
# its successor `fix/1050-1033-1061-carry-rebased` was auto-deleted on merge,
# so every future push naming 1050 is refused by a dead branch
# (tabsii-com/tabsii-platform#1112).
#
# **`git merge-base --is-ancestor` is not the primitive.** A rebase rewrites
# every commit, so the predecessor's tip stops being an ancestor of its own
# successor -- verified by experiment (`is-ancestor` rc=1 on exactly the pair
# `git cherry` reports as fully equivalent). Ancestry answers a strictly
# narrower question and would have caught none of the reported case.
#
# So the question asked here is not "is this branch mine?" -- identity is not a
# trustworthy signal in this estate and this script never compares it -- but the
# stronger, decidable one:
#
#   **does the candidate carry any work the branch being pushed does not
#   already have?**
#
# If it does not, there is nothing to collide over whoever made it: pushing
# cannot duplicate or lose work that is already in hand. That is a property of
# the object graph, not of a name, and it is what makes the discount safe to
# grant automatically rather than via a hand-maintained skip list.
#
# **A claim reserves FUTURE work; a content test can only see PAST work.**
# This is the predicate's structural limit, and the next reader should have it
# rather than rediscover it. `git cherry` compares commits that exist; a claim
# is about commits that do not exist yet. So no content-subset test can ever be
# complete, and the only safe posture is the one taken here: discount ONLY on
# positive evidence that the candidate is a replay of work already in hand, and
# read everything else -- including its own silence -- as a rival.
#
# It FAILS CLOSED at every step -- each `return 1` means "conflict", and the
# only route to `return 0` is positive evidence:
#
#   1. Both refs must be known. No local tip, no candidate sha, no discount.
#   2. The candidate's objects must be present LOCALLY. A branch this machine
#      has never fetched cannot be shown to be superseded, and absence of
#      evidence is not evidence of supersession.
#   3. The candidate must carry AT LEAST ONE COMMIT OF ITS OWN. Step 5 asks
#      "does the candidate carry work this push does not already have?", and
#      that question is VACUOUSLY TRUE of a candidate with no commits at all --
#      a branch pointing at `dev`'s tip, or at anything else already reachable
#      from the pusher. `git cherry` then emits nothing, no `+` line is found,
#      and a LIVE RESERVATION is discounted while the notice calls it a
#      superseded predecessor. Reproduced: with `fix/1050-other-agent` pushed
#      at `dev`'s tip, `--guard fix/1050-mine` printed `discounted
#      fix/1050-other-agent` and exited 0.
#
#      That is the LIKELY rival shape, not an exotic one. AGENTS.md asks for
#      exactly it -- "push your branch as soon as it exists. The claim is a
#      reservation; the branch is the evidence" -- so an agent that stakes an
#      issue before writing code produces a commitless branch by following the
#      documented protocol. It is also symmetric: two sessions staking one
#      issue seconds apart both sit at `dev`'s tip and would each discount the
#      other, which is the 2026-08-03 collision shape. Nothing else catches it
#      either -- a commitless branch has no open PR to find, and `--guard`
#      deliberately never reads the `in-progress` label.
#
#      **Own commits are counted against the branch being pushed, not against
#      `dev`** -- `git rev-list <candidate> --not <local tip>`, i.e. the
#      commits on the candidate's side of the merge base with this push. Three
#      reasons that is the right base:
#        - It is the SAME frame of reference steps 4 and 5 already use, so the
#          three cannot disagree about what "beyond" means. A second base would
#          be a second authority, which is this estate's most-repeated defect.
#        - `dev` is not knowable here. `--guard` is handed one branch name by a
#          pre-push hook, is never told the integration branch, and a candidate
#          need not derive from it anyway.
#        - It answers the question actually being asked. Every candidate that
#          must not be discounted counts zero against it: at `dev`'s tip, at
#          the pusher's own tip (the symmetric race), and at any older ancestor
#          -- all are already reachable, so none carries anything of its own.
#      A candidate whose only commits are MERGES counts non-zero here and is
#      refused by step 4 instead; this step is deliberately not the one that
#      decides that case.
#   4. No unmerged MERGE COMMIT. `git cherry` compares non-merge commits by
#      patch id and omits merges entirely -- verified: a candidate carrying one
#      merge commit had that commit listed by neither `+` nor `-`, so an evil
#      merge's own resolution would be invisible. Refuse rather than guess.
#   5. `git cherry <local tip> <candidate>` must emit no `+` line. `-` means an
#      equivalent patch is already present (what a rebase produces); `+` means
#      the candidate carries something this push does not.
#
# Known FALSE POSITIVES (still blocks, conservatively):
#   - a predecessor that was SQUASHED or amended rather than replayed -- the
#     patch ids differ, so it reads as a rival. Verified: `git merge --squash`
#     of the predecessor produces `+` on both of its commits.
#   - a predecessor whose objects are not in this clone (fresh machine).
#   - a candidate carrying a merge commit.
#   - a predecessor left pointing at a commit already reachable from this push
#     (someone reset it back onto `dev`). It carries nothing of its own, so
#     step 3 refuses it -- correctly, because that branch is indistinguishable
#     from a rival's fresh reservation.
#
# Known FALSE NEGATIVES (discounts something that was not ours):
#   - a genuine rival that has committed real work, EVERY commit of which has
#     a patch-id equivalent already in the pushed branch (a cherry-pick of
#     exactly this work and nothing more), AND whose objects happen to be in
#     this clone. Their work is then already fully in hand, so there is no
#     duplicated effort left to warn about -- the discount is right for the
#     wrong reason. This is the residual gap. Step 3 narrows it to rivals who
#     have actually duplicated this push's content, rather than leaving it open
#     to anyone who merely staked a branch, but it cannot close it: see the
#     future/past limit at the top of this comment.
#   - the reverse of (4) cannot happen: a merge is refused, never absorbed.
branch_is_absorbed() {
  _abs_cand="$1"
  _abs_tip="$2"

  [ -n "$_abs_cand" ] || return 1
  [ -n "$_abs_tip" ] || return 1

  git cat-file -e "${_abs_cand}^{commit}" 2>/dev/null || return 1

  # Step 3 (see above): zero own commits is a RESERVATION, never a
  # supersession. Counted against the branch being pushed, which is the same
  # base the two checks below use. A count that cannot be computed, or that
  # comes back non-numeric, is a cannot-tell and fails closed like everything
  # else here -- `[` itself returns non-zero on a non-integer operand, so the
  # `|| return 1` covers that without a second parse.
  _abs_own=$(git rev-list --count "$_abs_cand" --not "$_abs_tip" 2>/dev/null) || return 1
  [ -n "$_abs_own" ] || return 1
  [ "$_abs_own" -gt 0 ] 2>/dev/null || return 1

  _abs_merges=$(git rev-list --merges --count "$_abs_cand" --not "$_abs_tip" 2>/dev/null) || return 1
  [ "$_abs_merges" = "0" ] || return 1

  _abs_cherry=$(git cherry "$_abs_tip" "$_abs_cand" 2>/dev/null) || return 1
  if printf '%s\n' "$_abs_cherry" | grep -q '^+'; then
    return 1
  fi
  return 0
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
#   2. the branch name (`<type>/<number>-slug`) -- DERIVED the same way on
#      BOTH sides (#1672), not matched as a substring of one. A boundary
#      regex over the raw `headRefName` text, tested against a search number
#      already stripped of leading zeros, is how a zero-padded PR went blind:
#      `0010` strips to `10`, and `(^|[^0-9A-Za-z])10([^0-9A-Za-z]|$)` cannot
#      match literal `0010`, because the preceding `0` is alphanumeric. Fixed
#      by extracting the headRefName's OWN `<type>/<number>-` prefix via a jq
#      capture, stripping ITS leading zeros the same way `guard_issue` is
#      stripped below, and comparing the two normalised numbers for equality
#      -- rather than searching for one inside the literal text of the other.
#      This is deliberately narrower than a bare boundary-anchored substring
#      search: `dm-04` and `104` carry no `/`, so nothing is derived from
#      them at all, and a bare digit run that merely CONTAINS the target
#      (`fix/13520-thing` vs issue 1352) still does not equal it once both
#      are normalised. `capture()` produces NO output (not `false`) when the
#      pattern does not match, which would silently drop the whole `or`
#      chain for a PR like `chore/rename` if used bare -- wrapped in `[...]`
#      first so a non-match becomes an empty array (one output), never zero.
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
# $1 is normalised (leading zeros stripped) HERE, once, rather than trusting
# every caller to have done it -- the plain (non-`--guard`) path passes the
# raw `$ISSUE` a caller typed, which may itself be zero-padded and was never
# stripped before reaching this function.
#
# $2 is the repo slug (`owner/name`) the closing-reference check compares
# against -- callers already resolve this via `repo_slug()` before calling.
claim_select_expr() {
  _n=$(printf '%s' "$1" | sed 's/^0*\([0-9]\)/\1/')
  _slug="$2"
  printf '(([.closingIssuesReferences[]? | select(.number == %s and ((.repository.owner.login + "/" + .repository.name) == "%s"))] | length > 0) or (([.headRefName | capture("^[^/]*/(?<n>[0-9]+)-")] | if length > 0 then ((.[0].n | sub("^0+";"")) as $s | if $s == "" then "0" else $s end) else "" end) == "%s") or ((.body // "") | test("(^|[^0-9A-Za-z])(refs?|references?)[ \\t]*:?[ \\t]*#%s([^0-9A-Za-z]|$)"; "i")))' \
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
CANNOT_TELL=0
REASONS=""

note() { REASONS="${REASONS}  $1\n"; TAKEN=1; }

# A DEFINITE signal (open PR, remote branch, someone else's label) always
# outranks an ambiguous one: if anything sets TAKEN=1 the verdict is "Taken"
# regardless of CANNOT_TELL, so an unreadable check downgrades the verdict
# only when nothing conclusive was found either way (#1691). See
# `claim_held_by` above for why "cannot tell" must never collapse into either
# "free" or "taken" for certain.
note_cannot_tell() { REASONS="${REASONS}  $1\n"; CANNOT_TELL=1; }

# ADVISORY: reported, never blocking (ADR-0008, ADR-0009 Sec3b; biffo-fleet#372, M5).
# What used to be `note()` for the label and the open-PR/branch checks below, now that
# the lease is the authority for those two and can answer conclusively. Kept distinct
# from `note()` on purpose -- a caller reading REASONS cannot tell an advisory line from
# a blocking one by string alone, but the exit code and TAKEN can, and that is the
# property every downstream reader (this script's own summary, and any external caller
# parsing `Taken`/`Free`) must keep being able to rely on.
note_advisory() { REASONS="${REASONS}  $1\n"; }

# --- THE LEASE, THE ONE AUTHORITY (ADR-0008; ADR-0009 Sec3b; biffo-fleet#372, M5) -------
#
# `claim.sh` used to have THREE signals that each independently set TAKEN=1: the label,
# an open PR, a remote branch. Every one is correct about ITSELF and none is correct
# about reality -- tabsii-platform#1126 is the measured cost: a builder pushed the
# cross-tenant RLS fix across 304/337 policies and died before opening a PR. The label
# said Taken from a claim nobody was renewing, the branch alone ALSO said Taken with no
# takeover path (#180), and the issue became permanently unreachable -- "the signal that
# proves work is happening became the signal that guarantees it never resumes" (ADR-0008).
#
# The lease registry (ADR-0007) is a claim with an expiry the holder must keep renewing,
# so a dead holder is detected by absence rather than by a human noticing. It lives in
# `biffo-fleet`, a SEPARATE repo on this same machine (ADR-0007: single machine, no
# remote-host handling) -- this script cannot `import` it, so it shells out to the one
# bridge that repo built for exactly this (`bin/liveness.py`; see its own docstring).
#
# lease_query <issue> prints one TAB-separated line to stdout and returns:
#   0  "live\t<holder>\t<expires_at>"  -- a live lease names a holder
#   0  "free\t\t"                      -- the registry answered: nobody holds a live lease
#   2  "unknown\t\t<reason>"           -- could not consult it (see below)
lease_query() {
  _lq_bridge="${FLEET_DIR:-$HOME/.claude/fleet}/liveness.py"
  if [ ! -f "$_lq_bridge" ]; then
    printf 'unknown\t\tliveness.py not found at %s (not yet deployed, or this box has no fleet)\n' "$_lq_bridge"
    return 2
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'unknown\t\tpython3 not on PATH\n'
    return 2
  fi
  _lq_out=$(python3 "$_lq_bridge" live "$(repo_slug)" "$1" 2>/dev/null)
  _lq_rc=$?
  case "$_lq_rc" in
    0) printf '%s\n' "$_lq_out"; return 0 ;;
    2) printf '%s\n' "$_lq_out"; return 2 ;;
    *)
      # A THIRD exit code from the bridge is a fact this script has never seen before,
      # and a check whose only two known outcomes are hard-coded above must not silently
      # trust a third one as either "live" or "free". Same "cannot tell" reasoning as
      # everywhere else in this file.
      printf 'unknown\t\tliveness.py exited %s, an outcome this script does not recognise\n' "$_lq_rc"
      return 2 ;;
  esac
}

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
  claim_held_by "$ISSUE" "$HOLDER"
  _held_status=$?
  if [ "$_held_status" -eq 0 ]; then
    gh_issue edit "$ISSUE" --remove-label "$LABEL" >/dev/null 2>&1 || {
      echo "${RED}claim: could not remove the '$LABEL' label.${OFF}" >&2
      exit 2
    }
    echo "${GREEN}Released.${OFF} ${DIM}(held by $HOLDER)${OFF}"
    exit 0
  fi
  # Cannot tell (#1691): the comment read itself failed, so this is NOT "we
  # checked and it's not yours" -- it is "we could not check". Reporting the
  # latter as the former is what used to make a genuinely-held claim
  # unreleasable on nothing but a network blip. Refuse the same as a real
  # mismatch (clearing on a guess is worse than a stuck label) but say so
  # honestly and with the estate's own "cannot tell" exit code.
  if [ "$_held_status" -eq 2 ]; then
    echo "${RED}claim: cannot tell whether #$ISSUE is held by '$HOLDER'${OFF} — the issue's comments were unreadable." >&2
    echo "${DIM}  Not releasing on an unreadable read: that could clear somebody else's claim.${OFF}" >&2
    echo "${DIM}  Retry once gh/network is working, or check by hand before removing the label.${OFF}" >&2
    exit 2
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
  # A BATCH BRANCH NAMES A SEQUENCE, NOT AN ISSUE.
  #
  # `batch/04-stale-reconverge` fits `<type>/<number>-<slug>` exactly, so this read `04` as
  # an issue and refused the push. Measured 2026-08-21: it blocked the FIRST reconverge the
  # Lander ever attempted -- and batching is the remedy `fleet-land` prescribes for a strict
  # branch, so this defect blocks the strategy meant to fix landing. `batch/02-gated-trio`
  # escaped only because no open branch happened to contain `-02-`.
  case "$GUARD_BRANCH" in
    batch/*) exit 0 ;;
  esac

  guard_issue=$(derive_branch_issue "$GUARD_BRANCH")

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
  absorbed_branches=""

  # The local tip of the branch being pushed, resolved once. Empty when it
  # cannot be resolved (the caller named a branch this repo does not have), and
  # `branch_is_absorbed` then discounts nothing -- exactly today's behaviour.
  guard_tip=$(git rev-parse --verify --quiet "refs/heads/$GUARD_BRANCH^{commit}" 2>/dev/null) || guard_tip=""

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

  # --- the claim record's own idea of who currently holds $guard_issue --------
  #
  # #1698: `branch_is_absorbed` below answers "does the candidate carry work I
  # lack?" -- a content test, not an identity one. Two independent sessions
  # rebasing the same predecessor onto the same tip produce patch-id-equivalent
  # commits, so content alone cannot tell "my own rebase of my own predecessor"
  # from a genuine rival's rebase of the same starting point. Read once, used
  # below to gate every absorption on this push -- not by comparing $2's shape
  # the way `claim_held_by` does (`--guard` runs with no token, by design, see
  # the header), but by checking whether the record's own `claim-branch` names
  # THIS branch.
  _guard_confirmed_branch=$(claim_guard_branch "$guard_issue")
  _guard_confirmed_rc=$?
  case "$_guard_confirmed_rc" in
    0)
      if [ "$_guard_confirmed_branch" = "$GUARD_BRANCH" ]; then
        _guard_identity_ok=1
        _guard_identity_reason=""
      else
        _guard_identity_ok=0
        _guard_identity_reason="the claim record for #$guard_issue names \`$_guard_confirmed_branch\`, not this branch"
      fi
      ;;
    1)
      _guard_identity_ok=0
      _guard_identity_reason="#$guard_issue carries no claim record naming a branch (unclaimed, or claimed before #1698's fix)"
      ;;
    *)
      _guard_identity_ok=0
      _guard_identity_reason="the claim record for #$guard_issue could not be read"
      ;;
  esac

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
    # Derive each CANDIDATE branch's issue the same way $guard_issue was
    # derived (#1672), and compare the two normalised numbers -- not a
    # substring search for $guard_issue inside the candidate's raw text. See
    # `derive_branch_issue` above for why that asymmetry was the defect.
    # Each candidate that names the same issue is then classified by LINEAGE
    # (see `branch_is_absorbed`) AND, when lineage says absorbed, by IDENTITY
    # (`$_guard_identity_ok`, above): a genuine rival is always `rival`; a
    # content-superseded predecessor is only actually `absorbed` when the
    # claim record also confirms this push as the current claim -- otherwise
    # it is `denied` and treated as a conflict too (#1698 fails this closed,
    # rather than the silent pass it replaces), with a message explaining why.
    # The candidate's SHA -- `git ls-remote`'s first, tab-separated field -- is
    # what makes lineage answerable, so it is no longer thrown away by a `sed`
    # that kept only the name.
    _classified=$(printf '%s\n' "$raw_branches" |
      while IFS= read -r _line; do
        case "$_line" in
          *"refs/heads/"*) ;;
          *) continue ;;
        esac
        _cand=${_line##*refs/heads/}
        [ -n "$_cand" ] || continue
        [ "$_cand" = "$GUARD_BRANCH" ] && continue
        _cand_issue=$(derive_branch_issue "$_cand")
        [ -n "$_cand_issue" ] || continue
        [ "$_cand_issue" = "$guard_issue" ] || continue
        _cand_sha=$(printf '%s\n' "$_line" | cut -f1)
        if branch_is_absorbed "$_cand_sha" "$guard_tip"; then
          if [ "$_guard_identity_ok" -eq 1 ]; then
            printf 'absorbed %s\n' "$_cand"
          else
            printf 'denied %s\n' "$_cand"
          fi
        else
          printf 'rival %s\n' "$_cand"
        fi
      done)

    other_branch=$(printf '%s\n' "$_classified" | sed -n 's/^rival //p' | head -1)
    denied_branch=$(printf '%s\n' "$_classified" | sed -n 's/^denied //p' | head -1)
    absorbed_branches=$(printf '%s\n' "$_classified" | sed -n 's/^absorbed //p')
    if [ -n "$other_branch" ]; then
      conflict=1
      findings="${findings}  ${RED}branch${OFF}     $other_branch\n"
    elif [ -n "$denied_branch" ]; then
      conflict=1
      findings="${findings}  ${RED}branch${OFF}     $denied_branch ${DIM}(content looks like a superseded predecessor, but $_guard_identity_reason)${OFF}\n"
    fi
  fi

  # A discount a guard grants silently is a guard nobody can audit, so say so
  # -- on stderr, only when it actually fired. One line per branch (#1698):
  # $absorbed_branches can hold more than one name, and explaining several in
  # the singular sent whoever read it looking for the wrong branch.
  if [ -n "$absorbed_branches" ]; then
    printf '%s\n' "$absorbed_branches" | while IFS= read -r _ab; do
      [ -n "$_ab" ] || continue
      echo "${DIM}claim --guard: discounted $_ab -- every commit on it is already carried by${OFF}" >&2
      echo "${DIM}$GUARD_BRANCH, and the claim record for #$guard_issue confirms $GUARD_BRANCH, so${OFF}" >&2
      echo "${DIM}it is a superseded predecessor rather than a rival claim (#1112).${OFF}" >&2
    done
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

# --- 0.5. THE LEASE. The one authority for "is this being worked on" ---------
#
# ADR-0008: "The lease decides. A unit with no live lease is available, whatever
# else exists." So this runs FIRST, ahead of the label/PR/branch below, and its
# answer decides whether those three still BLOCK (`note`) or only INFORM
# (`note_advisory`) -- the "many inputs, one authority" split ADR-0008 draws
# between detection (fine, encouraged, kept) and a second STORED verdict (the
# defect this migration removes).
#
# INTERIM RULE FOR DISAGREEMENT (temporarily SEVEN sources, not one -- ADR-0008's
# own phrase for this migration window): a LIVE lease always wins outright. A
# lease the registry can positively report as FREE demotes the label/PR/branch
# below to advisory. But when the lease CANNOT be consulted at all -- the most
# likely state today, since nothing acquires one until the fleet's restart
# milestones (biffo-fleet#376/#377) wire dispatch through `supervise.py`, and
# `bin/liveness.py` itself needs a one-time hand symlink into $FLEET_DIR before
# any instance repo can even reach it (see `lease_query`'s own docstring) -- this
# falls back to EXACTLY the pre-migration three-signal behaviour below, unchanged,
# rather than degrading every claim to "Cannot tell" for the length of that gap.
# That would be a worse regression than the one this migration fixes: a script
# every agent runs before starting any work would refuse ALL of them.
LEASE_KNOWN=0
_lease_line=$(lease_query "$ISSUE")
_lease_rc=$?
_lease_kind=$(printf '%s' "$_lease_line" | cut -f1)
_lease_holder=$(printf '%s' "$_lease_line" | cut -f2)
_lease_exp=$(printf '%s' "$_lease_line" | cut -f3)
case "$_lease_rc $_lease_kind" in
  "0 live")
    LEASE_KNOWN=1
    if [ -n "$HOLDER" ] && [ "$_lease_holder" = "$HOLDER" ]; then
      echo "${DIM}lease      held by ${HOLDER} — that is you${OFF}"
    else
      note "${RED}lease${OFF}      held by ${_lease_holder:-unknown}, expires ${_lease_exp:-unknown}"
    fi
    ;;
  "0 free")
    LEASE_KNOWN=1
    ;;
  *)
    # 2/unknown, or any shape this script does not recognise -- fail closed to
    # the OLD rule (LEASE_KNOWN stays 0), never to "must be free".
    ;;
esac

# --- 1. The label. Easiest to check, easiest to forget. ----------------------
#
# ADVISORY once the lease has an opinion (LEASE_KNOWN=1): reported via
# `note_advisory` rather than `note`, so it is never again what makes an issue
# permanently unreachable on its own (ADR-0009 Sec3, once the lease exists).
# Still the ONLY signal used, unchanged, when the lease could not be consulted.

case ",$labels," in
  *",$LABEL,"*)
    updated=$(gh_issue view "$ISSUE" --json updatedAt --jq .updatedAt 2>/dev/null)
    # Whose claim is it? (#1279) A claim carrying OUR token is not a collision --
    # it is the orchestrator that dispatched us. Without this a delegated agent
    # cannot tell its own reservation from a stranger's and correctly refuses to
    # start, which is the failure this flag exists to remove.
    #
    # Tri-state (#1691): a comment-read failure must not read as "not held by
    # you" (label present + genuinely someone else's) OR as "held by you"
    # (which would waive the label past the four-signal check entirely) --
    # either reading lets a session claim over the top of a holder it simply
    # failed to read. `note_cannot_tell` still blocks the claim (fail closed,
    # same as an ordinary someone-else's-label), but reports the verdict
    # honestly as "cannot tell" rather than a confident "Taken" it did not
    # earn -- unless something else on the four signals IS conclusive, in
    # which case that conclusive finding is what decides the verdict.
    _held_status=1
    if [ -n "$HOLDER" ]; then
      claim_held_by "$ISSUE" "$HOLDER"
      _held_status=$?
    fi
    case "$_held_status" in
      0) echo "${DIM}label      carries '$LABEL', held by ${HOLDER} — that is you${OFF}" ;;
      2)
        if [ "$LEASE_KNOWN" -eq 1 ]; then
          note_advisory "${YELLOW}label${OFF}      carries '$LABEL' — cannot tell who holds it (comments unreadable; advisory, the lease already answered)"
        else
          note_cannot_tell "${YELLOW}label${OFF}      carries '$LABEL' — cannot tell who holds it (comments unreadable)"
        fi
        ;;
      *)
        if [ "$LEASE_KNOWN" -eq 1 ]; then
          note_advisory "${YELLOW}label${OFF}      carries '$LABEL' (issue last updated $updated) — advisory, the lease decides"
        else
          note "${YELLOW}label${OFF}      carries '$LABEL' (issue last updated $updated)"
        fi
        ;;
    esac
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
  # ADVISORY once the lease has an opinion (ADR-0008/0009 Sec3b): a human working by
  # hand opens a PR and holds no lease, and this is what keeps that visible without
  # letting it wedge the issue the way it did for tabsii-platform#1126's branch.
  if [ "$LEASE_KNOWN" -eq 1 ]; then
    note_advisory "${RED}open PR${OFF}    see above — advisory, the lease decides"
  else
    note "${RED}open PR${OFF}    see above — someone has working code"
  fi
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
  # ADVISORY once the lease has an opinion (ADR-0008/0009 Sec3b) -- this is THE signal
  # ADR-0009 Sec3b names by number: "a remote branch names this issue" alone used to set
  # TAKEN=1 unconditionally and had no takeover path (#180). tabsii-platform#1126 is
  # exactly this shape: a branch existed, no PR, the builder was gone, and this line is
  # why the issue could never be reclaimed. It stays reported -- a human working by hand
  # creates a branch and holds no lease -- it just no longer decides on its own.
  if [ "$LEASE_KNOWN" -eq 1 ]; then
    note_advisory "${RED}branch${OFF}     a remote branch names this issue — advisory, the lease decides"
  else
    note "${RED}branch${OFF}     a remote branch names this issue"
  fi
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

# A DEFINITE signal above always wins (checked first), so this only fires when
# nothing conclusive was found but at least one check genuinely could not run
# (#1691). Refuse exactly like "Taken" -- an unreadable check must never grant
# a claim -- but say so honestly instead of reporting certainty nobody has.
if [ "$CANNOT_TELL" -eq 1 ]; then
  printf '%b' "${RED}Cannot tell.${OFF} Signals:\n$REASONS"
  echo
  echo "${DIM}Refusing to claim over an unknown holder -- an unreadable check must never${OFF}"
  echo "${DIM}read as free. Retry once gh/network is working.${OFF}"
  exit 2
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
#
# `claim-branch` (#1698) is the fact `--guard` reads back via
# `claim_guard_branch` to confirm a discount is safe -- this comment is that
# mechanism's one durable, non-worktree record, so nothing new is invented,
# only this field added to it. AGENTS.md's own sequence puts worktree-and-
# branch creation before this claim runs, so the branch normally already
# exists; when it genuinely does not (detached HEAD, or `HEAD` itself, which
# `--abbrev-ref` returns rather than a real name), the field is OMITTED
# entirely rather than written empty -- an empty `claim-branch:` would match
# any `case *"$BRANCH_MARK"*` probe as "present" while naming nothing, the
# same empty-token trap `claim_held_by` already guards against for $2 (#826).
_claim_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')
case "$_claim_branch" in
  '' | HEAD) _claim_branch='' ;;
esac
gh_issue edit "$ISSUE" --add-label "$LABEL" >/dev/null 2>&1 || {
  echo "${RED}claim: could not apply the '$LABEL' label.${OFF}" >&2
  echo "${DIM}  Not claimed. Do not start work on the assumption that it worked.${OFF}" >&2
  exit 2
}
gh_issue comment "$ISSUE" \
  --body "Claimed at $(date -u +%FT%TZ) by \`$(git config user.name 2>/dev/null || echo agent)\`. ${HOLDER_MARK}${HOLDER}${_claim_branch:+ ${BRANCH_MARK}${_claim_branch}} Release it — remove the label — on merge, or if you stop." \
  >/dev/null 2>&1

echo "${GREEN}Claimed.${OFF}"
echo "${DIM}Push your branch as soon as it exists: a claim is a reservation, the branch${OFF}"
echo "${DIM}is the evidence, and the window between them is where collisions happen.${OFF}"
exit 0
