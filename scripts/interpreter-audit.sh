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
# Still true after #1681 widened the scan to scripts/*.sh: the widened audit
# found two genuine, live mismatches (not fixtures) in `dev` --
# `scripts/shared-sync-daily.sh` and `scripts/shared-sync.sh` each invoking a
# bash-shebang target via explicit `sh` -- plus a quoted-variable-path
# invocation of `claim.sh` that was resolvable but unparseable as written.
# All three were fixed in the same round the scan widened (see the case
# matrix above), so the "no residue to protect" property still holds:
# checked live at landing, 41 explicit-interpreter invocations across 17
# workflow files and 40 script files, 0 mismatched, 0 could not examine.
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
# ## Fourth-pass fix: the audit's own denominator was wrong (#1625)
#
# The fourth prosecution of #1619 found this script red-lighting CORRECT
# code, and worse, silently miscounting on some inputs while still exiting
# 0 -- a guard about an unstated denominator (#1413) carrying that exact
# defect in itself, for the third time (see the header above: INERT, then
# BROKEN, then silently-examined-nothing were the first three).
#
# Cause: find_invocations()'s awk `process()` advances `rest` past each
# invocation it just parsed with `rest = substr(rest, RSTART + RLENGTH)`,
# but awk has exactly one set of RSTART/RLENGTH, shared across every
# match() call in the function. The flag-skip loop and the token-extraction
# match() calls both overwrite it after the interpreter match() that found
# the invocation, so that final substr() consumed a stale offset scoped to
# a short inner string (`tail`/`tail2`), not to `rest` itself. Residue was
# left behind and rescanned as a bogus second invocation -- landing
# wherever the interpolated script PATH LENGTH happened to put it, which is
# why `scripts/foo.sh` passed, `scripts/foo2.sh` false-MISMATCHed on a
# phantom `sh` invocation nothing in the line names, and `scripts/a.sh`
# silently reported 2 invocations for 1 real one while still exiting 0.
#
# Fix: a `consumed` local accumulates lengths captured the instant each
# match() returns (flag length, whitespace length, token length), and
# `rest` is advanced from that sum instead of from whatever match() left in
# RSTART/RLENGTH last. See `scripts/interpreter-audit.test.sh` for the
# fixture matrix (all four filenames from #1625's own reproduction) plus
# every property this file's exit-code contract still had to hold
# afterward, executed under both bash and dash.
#
# ## Sixth-pass: script-to-script invocations were entirely invisible (#1681)
#
# Everything above reads `.github/workflows/*.yml` / `*.yaml` only -- see the
# original "## What this checks" section below. A script invoking ANOTHER
# script with an explicit, mismatched interpreter was completely outside what
# this audit examined: `mismatched: 0` was a true statement about workflow
# files and said nothing about `scripts/*.sh` calling `scripts/*.sh`.
#
# The concrete miss: `scripts/branch-health-plan-only-detection.test.sh`
# (added for #1582) invoked `sh "$REPO_ROOT/scripts/branch-health.sh"
# --branch dev` -- branch-health.sh declares `#!/usr/bin/env bash` and needs
# it (`set -uo pipefail`). CI run `32556851227` died with `Illegal option
# -o pipefail`, misdiagnosed by the test's own assertions as a missing-output
# bug, because the crash produced none. This audit ran clean on that exact
# commit. (That specific call site was fixed at the source before this round
# -- #1582's own PR -- so it can no longer serve as live fail-first evidence;
# see the self-test for a deliberately-constructed equivalent instead.)
#
# ### Reused, not re-derived
#
# `find_invocations()` and its flag/line-continuation/`-c`/shell-variable
# handling are unchanged and now run against `scripts/*.sh` bodies exactly as
# they already ran against workflow YAML -- the parsing problem (does this
# line invoke `sh`/`bash` against a resolvable script path?) does not care
# what kind of file the line came from.
#
# ### What a script body has that a workflow YAML mostly does not: prose
#
# Scanning every line of a `run:` step (as this audit already did, with no
# YAML-aware filtering at all) works because workflow files in this repo do
# not carry stray comments or string literals that happen to contain
# `sh scripts/whatever.sh`. Script bodies are saturated with exactly that --
# usage comments (`# Run: sh scripts/foo.test.sh`), help text
# (`echo "sh scripts/claim.sh 1234 --as <token>"`), desktop-notification
# strings, and test-scenario labels (`assert_case "matrix: bash
# scripts/${name}.sh ..."`). Reusing the line-scan verbatim against script
# bodies would report every one of those as an "invocation" -- a guard that
# is red on prose it can't tell from code trains people to stop reading it
# exactly like a guard that is red on legitimate residue (AGENTS.md §9).
#
# Two filters close that gap, both applied uniformly to EVERY file this
# audit reads (workflow YAML included -- a workflow's `run: |` block can
# carry the identical shape, e.g. a `gh pr comment` body built from quoted
# heredoc-style lines; nothing here is script-specific):
#
#   - **`strip_unquoted_comment()`** truncates a logical line at the first
#     `#` that is not inside a quoted string, so a doc comment mid-body
#     (not just a line whose first character is `#`) is never scanned as
#     code.
#   - **`is_quoted_before()`** computes shell quote parity (single- and
#     double-quote, backslash-escaped) up to the position of a candidate
#     `sh`/`bash` match, against the WHOLE logical line -- not the
#     already-sliced `rest` a repeat match operates on, which would have lost
#     any quote opened earlier in the line. A match that lands inside an
#     open quote is a string, not a command, and is never emitted as a
#     record. Quoting that opens on one physical line and is still open at
#     end-of-line, OUTSIDE a heredoc (e.g. an unterminated multi-line
#     double-quoted string), is NOT tracked -- each call starts fresh per
#     logical line. That is a known, accepted gap (see "Still out of scope"
#     below), not a silent one. Heredoc BODIES are tracked separately, by
#     `detect_heredoc()` in the main record loop below (#1804) -- see the
#     "Seventh-pass" header section further down.
#
# ### Case matrix -- captured live against this repo at the commit this
# ### landed on, not invented
#
# Every row below is real output from `grep`/`sed` against the actual files
# named, not a constructed example (`git log` on this commit shows the exact
# greps used). "Verdict" is what the WIDENED audit does with it now.
#
#   MUST be caught (real invocations this audit was blind to before #1681):
#   - `scripts/shared-sync-daily.sh:95` (pre-fix): `sh scripts/shared-sync.sh
#     --scheduled --estate "$ESTATE"` -- bare, unquoted, in command position.
#     shared-sync.sh declares `#!/usr/bin/env bash`. Verdict: MISMATCH.
#     Fixed in this same round (see "Live findings" below) -- invoked as a
#     bare executable now, so the CURRENT tree reports CLEAN, not MISMATCH;
#     the self-test's synthetic fixture reproduces the pre-fix shape so the
#     MISMATCH path itself stays covered.
#   - `scripts/shared-sync.sh:1990` (pre-fix): `sh
#     "$TEMPLATE_ROOT/scripts/gate-coverage.sh" 2>&1` -- bare `sh`, quoted
#     variable target. gate-coverage.sh declares `#!/usr/bin/env bash`.
#     Verdict: UNPARSEABLE (quoted target, per existing design) -- still
#     fails the audit, which is the point: an invocation this audit cannot
#     resolve is unexamined, not fine, exactly as for a workflow. Also fixed
#     in this round.
#
#   MUST NOT be caught (prose containing invocation-shaped text):
#   - `scripts/biffo.sh:105`: `echo "    sh scripts/shared-sync.sh --estate
#     <path-to-your-repos>" >&2` -- help text. `sh` sits inside an open
#     double quote. Verdict: filtered by `is_quoted_before()`.
#   - `scripts/claim.sh:993`: `echo "  sh scripts/biffo.sh claim $ISSUE --as
#     $_s" >&2` -- same shape. Filtered the same way.
#   - `scripts/branch-health.sh:427`: a `notify-send` message literal
#     containing "... sh scripts/branch-health.sh" inside a double-quoted
#     string spanning a `\`-continued `notify-send` call. Filtered.
#   - `scripts/interpreter-audit.test.sh:230`:
#     `assert_case "matrix: bash scripts/${name}.sh (correct code)" ...` --
#     a test-scenario label, not a command. `bash` sits inside the outer
#     double quote. Filtered.
#   - `scripts/verify-deployed.sh:96`: `_die "usage: sh
#     scripts/verify-deployed.sh <check-name> | --list"` -- usage text,
#     filtered the same way.
#   - `# Run: sh scripts/interpreter-audit.test.sh` (this file's own sibling
#     test's header comment) -- a full-line comment, filtered by
#     `strip_unquoted_comment()` before quote-checking is even reached.
#
#   Already CLEAN, unaffected by the widened scan (verified so the fix does
#   not newly flag correct code):
#   - `scripts/gate-coverage.sh:80`: `sh scripts/verify.sh --list` --
#     verify.sh declares `#!/usr/bin/env sh`. Matches.
#   - `scripts/shared-sync.sh:1794,1888,1969`: `sh scripts/biffo.sh ...` --
#     biffo.sh declares `#!/usr/bin/env sh`. Matches.
#
# ### Live findings fixed in this same round
#
# The two MUST-be-caught cases above were genuine, if latent, instances of
# this exact class already present in `dev` -- not fixtures. Both call sites
# now invoke their target as a bare executable path (respecting its own
# shebang) instead of forcing it through an explicit `sh`, the identical fix
# already applied to `scripts/branch-health-plan-only-detection.test.sh`
# (#1582) and to `scripts/practices-daily.sh`'s `branch-health.sh` call
# (#1709). Both targets already carry the executable bit (`100755`), so
# nothing else about the call sites needed to change.
#
# ### Still out of scope, and why
#
# `scripts/practices-daily.sh`'s `audit_json drift "sh scripts/shared-sync.sh
# --check --estate '$ESTATE'" ...` is a THIRD live instance of the same
# mismatch, one level more indirect than either fixed case above:
# `audit_json()` runs its second argument via `_out=$(sh -c "$_cmd" 2>&1)`,
# so this string is genuinely executed as `sh -c "sh scripts/shared-sync.sh
# ..."` at runtime -- a real `sh`-invokes-`bash`-shebang crash risk. It is
# NOT fixed here, and this audit does not and cannot catch it: the literal
# text `sh scripts/shared-sync.sh` sits inside a quoted string passed as a
# plain argument, indistinguishable at the text level from every MUST-NOT-
# catch case above (a string literal that happens to contain
# invocation-shaped text). Telling "this string is prose" from "this string
# will later reach `sh -c`" needs data-flow analysis this audit has no
# machinery for and should not grow ad hoc -- the same reasoning the
# existing header already gives for never parsing a direct `sh -c "..."`
# argument, one level further removed. Recorded here rather than silently
# left for the next reader to rediscover, same as the `$(sh ...)` gap below.
#
# ## Seventh-pass: heredoc bodies were scanned as code (#1804)
#
# `is_quoted_before()`/`strip_unquoted_comment()` (added for #1681, above)
# compute shell quoting per LOGICAL line. That is correct for the
# quoted-echo-prose shapes the case matrix above documents, but a heredoc
# body carries no shell quoting of its own -- it is raw text between an
# opener (`<<TOKEN`, `<<-TOKEN`, `<<'TOKEN'`, `<<"TOKEN"`, `<<\TOKEN`) and a
# terminator line, so every line inside one used to start "unquoted", and
# any `sh <name>.sh` / `bash <name>.sh`-shaped substring in a heredoc-based
# usage example read as a real invocation. Reproduced live against this
# script before this fix: a caller script documenting its own usage via
# `cat <<EOF2` / `  sh scripts/bash-only.sh --now` / `EOF2` produced a false
# MISMATCH, exit 1 -- the same MUST-NOT-catch shape the #1681 case matrix
# already lists for quoted echo prose, just heredoc-shaped instead of
# quote-shaped, and outside what either existing filter tracks (fleet-filed
# issue #1804, found by independent prosecution of #1681's own PR).
#
# Fix: a third piece of per-file state, `in_heredoc`/`heredoc_term`, tracked
# across the main record loop (NOT per logical line -- a heredoc body is
# precisely the multi-line case the existing two filters cannot see).
# `detect_heredoc()` recognises an opener on a physical line -- the line
# itself is still scanned (a real invocation may precede the opener, or may
# pipe the heredoc into its own stdin, e.g. `sh scripts/foo.sh <<EOF`) -- and
# every physical line after it is treated as literal, unscanned text, never
# comment-stripped or `\`-continuation joined, until a line matching the
# terminator is seen. See `scripts/interpreter-audit.test.sh` for the
# fixture matrix: all three terminator-quoting shapes #1804 names, plus
# `<<-` indentation, plus two regression guards -- a real mismatched
# invocation immediately before and immediately after a heredoc in the same
# file must still be caught (proves the state does not get stuck open), and
# a real invocation sharing its physical line with the opener itself must
# still be caught (proves the opener does not retroactively exempt its own
# line). (The terminator-match and opener-detection details below changed
# again in the Eighth-pass fix, #1817 -- this paragraph describes the
# CURRENT behaviour, not #1804's original tab-only version.)
#
# ## Eighth-pass: three more ways into the same stuck-open state (#1817)
#
# Independent prosecution of #1782/#1804's own PR found detect_heredoc()
# still got stuck open -- silently excluding every physical line from the
# opener to end-of-file, no error, no "could not examine" bump -- via three
# distinct mechanisms, none of them the terminator-quoting shapes #1804
# already covered:
#
#   1. **Closing check too strict.** A heredoc opened WITHOUT `-` (`<<EOF`,
#      `<<'EOF'`, ...) whose terminator is indented with SPACES never
#      matched `check_line == heredoc_term`, which only stripped leading
#      TABS, and only when the opener used `<<-`. Space-indented terminators
#      are the ordinary shape for a heredoc inside an indented shell
#      function, or inside a YAML `run: |` block -- YAML's block-scalar
#      indentation stripping makes an in-source-indented terminator line up
#      as a real, flush-left terminator at runtime, even though the raw text
#      this audit scans still carries the indent. Reproduced live: 5 of this
#      repo's own required deploy/destroy workflows got stuck open this way
#      (`deploy-infra.yml` worst -- 950 lines, only 159 scanned). Fixed by
#      stripping ALL leading whitespace (spaces and tabs) from the candidate
#      terminator line before comparing, for every heredoc shape, not just
#      `<<-`. Deliberately more lenient than POSIX (a plain heredoc's real
#      terminator match should be exact, with zero stripping) -- this audit
#      is a textual approximation, not a shell parser, and the cost of being
#      slightly too eager to close (an indented BODY line coincidentally
#      equal to the terminator word) is far smaller than the cost of staying
#      open to EOF.
#   2. **Opener detected inside a `#` comment.** `detect_heredoc()` ran
#      against the RAW physical line, before `strip_unquoted_comment()` ever
#      saw it -- so a comment merely NAMING a heredoc opener in prose (this
#      very file's own header comments do exactly that, e.g. "`` `<<TOKEN`
#      ``") was read as a real opener, whose terminator ("TOKEN") then never
#      legitimately appears alone on a line. Reproduced live: this file
#      itself, scanning its own header prose describing this very fix, got
#      stuck open on itself. Fixed by running `detect_heredoc()` against
#      `strip_unquoted_comment(line)` rather than the raw line -- detection
#      only, `line` itself is untouched so the existing `\`-continuation
#      join still sees the raw physical line.
#   3. **Opener detected inside an already-quoted string literal.** The same
#      failure, one level further removed: heredoc-opener-shaped text sitting
#      inside a single- or double-quoted shell/awk string literal -- data,
#      not code -- with no `#` in sight, so fix 2 above does not touch it.
#      This audit's OWN test fixtures build heredoc bodies via string
#      literals like `'cat <<EOF2'`, and `scripts/interpreter-audit.test.sh`
#      got stuck open scanning itself this way, once fix 2 stopped masking it
#      with an earlier stuck-open point. Fixed the same way `process()`
#      already filters `sh`/`bash` matches: `detect_heredoc()` now walks its
#      own candidate matches and skips (search continues past) any that
#      `is_quoted_before()` reports as sitting inside an open quote at that
#      position, rather than treating the first textual match as the opener
#      unconditionally.
#
# All three were found by attacking this PR's own #1804 fix directly rather
# than trusting its green self-test -- the audit's whole reason for
# existing (per this header, repeated across seven prior prosecution passes)
# is that a guard silently dropping what it cannot parse, with an unstated
# denominator, must never happen again, and it had recurred inside the exact
# commit meant to close the previous instance. See
# `scripts/interpreter-audit.test.sh` for the fixture matrix covering all
# three (fleet-filed issue #1817).
#
# ## Ninth-pass: a whitespace-truncated token fell through BOTH branches (#1809)
#
# `process()`'s token extraction (`match(tail2, /^[^ \t]+/)`) is a plain
# whitespace split -- it has no notion of quoting or `$(...)` nesting. A
# script argument built via a command substitution that itself contains a
# space before the target's own `.sh` suffix -- `sh "$(dirname "$0")/x.sh"`
# is the reproduction in the issue -- gets cut at that internal space, so the
# captured token is a fragment like `"$(dirname`: it neither ends in `.sh`
# (the CLEAN branch) nor contains `.sh` as a substring (the existing
# UNPARSEABLE branch, which is what correctly catches the simpler quoted-
# variable-target shape from the Sixth-pass, `sh "$TARGET_DIR/x.sh"`, because
# THAT token has no internal whitespace and so is never truncated). Neither
# branch fires, and the invocation is never printed at all -- not CLEAN, not
# MISMATCH, not "could not examine": a fourth, silent, uncounted state, which
# is exactly the denominator-honesty invariant this whole file exists to
# hold.
#
# Fixed by a third, narrower branch rather than a blanket "anything else is
# UNPARSEABLE" catch-all, because most tokens that fail both existing checks
# genuinely are not a script invocation at all (`bash -c 'do something'` has
# no `.sh` anywhere and should stay silent, not get flagged on a coincidence).
# The new branch fires only when BOTH of two independent signals hold:
#
#   1. `token_is_truncated()` -- the captured token itself carries syntactic
#      evidence of having been cut mid-construct: an unbalanced quote
#      (`"$(dirname` has one unmatched `"`) or an unbalanced paren (one
#      unmatched `(`). A syntactically complete word like `foo` or
#      `'whole-thing'` is balanced and never matches this.
#   2. `tail2` -- the FULL remainder of the line after the interpreter and
#      its flags, not the truncated first-whitespace-chunk `token` -- still
#      contains `.sh` somewhere past the truncation point. This is what tells
#      a real truncated script-path expression (`.sh` sitting later in the
#      same quoted/substituted argument) apart from an unrelated LATER
#      command on the same line that happens to mention `.sh`
#      (`bash foo && ./scripts/run.sh` -- `foo` is a complete, balanced
#      token, so signal 1 alone already excludes this case, but signal 2 is
#      what would otherwise false-positive on it if token balance were ever
#      relaxed).
#
# Both signals independently verified against this repo's real
# `.github/workflows/*.yml` and `scripts/*.sh` at the commit this fix landed:
# zero matches for either heuristic alone outside the fixture built to
# reproduce #1809, so this pass adds no new "could not examine" noise to the
# real-repo case in `scripts/interpreter-audit.test.sh`.
#
# ## Tenth-pass: the Ninth-pass gate itself had a sibling gap -- backticks (#1826)
#
# `token_is_truncated()` (signal 1 above) counted unbalanced `"`, `'` and
# `(`/`)` only. Backtick command substitution -- `` sh `dirname "$0"`/x.sh ``,
# the POSIX-portable sibling of the `$(dirname "$0")/x.sh` shape the
# Ninth-pass fix was built to catch -- is truncated by the exact same plain
# whitespace split (the captured token is `` `dirname ``), but that token has
# balanced quotes and balanced parens: no `"`, no `(`. `token_is_truncated()`
# returned false, signal 1 never fired, and the new UNPARSEABLE branch never
# ran -- the invocation fell through uncounted, reproducing #1809's own
# silent fourth state under different quoting syntax, in the very commit that
# closed #1809.
#
# Fixed by extending `token_is_truncated()` with a fifth counter: an odd
# number of backticks in the token is treated exactly like an unmatched `"`
# or unmatched `(` -- syntactic evidence the whitespace split cut through a
# still-open construct. This was chosen over reworking the whole function
# into a generic "starts with a known substitution opener with no matching
# closer" scan (the alternative #1826 raised): every opener this function
# cares about (`"`, `'`, `(`, `` ` ``) is single-character and has no nesting
# semantics worth modelling here, so a fifth parity counter is exactly as
# simple as the four it joins, carries the same false-positive profile (an
# odd count is always evidence of a cut, never of a complete word), and adds
# no new control flow -- a structural rewrite would cost more surface for a
# scan this function does not need. `tail2` (signal 2) is unchanged: it
# already contains `.sh` past the truncation point regardless of which
# opener did the truncating.
#
# Verified against this repo's real `.github/workflows/*.yml` and
# `scripts/*.sh`: zero backtick-parity matches outside the fixture built to
# reproduce #1826, so, as with the Ninth-pass fix, this adds no new "could
# not examine" noise to the real-repo case.
#
# Usage:
#   bash scripts/interpreter-audit.sh
#
# Exit 0: every explicit-interpreter invocation matches its script's shebang,
#         and none were left unparsed.
# Exit 1: at least one `sh`-invokes-`bash-shebang` mismatch, OR at least one
#         invocation could not be examined.
# Exit 2: not a git repo, `.github/workflows/` holds no workflow files, or
#         `scripts/` holds no `*.sh` files -- this audit checked nothing,
#         which is a configuration error, not a pass.

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

# Scripts calling scripts (#1681) -- same "checked nothing is a config error,
# not a pass" stance as WF_DIR above, applied to the second scan root.
SCRIPTS_DIR="scripts"
if [ ! -d "$SCRIPTS_DIR" ]; then
  echo "no $SCRIPTS_DIR -- this audit checked nothing" >&2
  exit 2
fi

SCRIPT_FILES=""
SCRIPT_COUNT=0
for f in "$SCRIPTS_DIR"/*.sh; do
  [ -f "$f" ] || continue
  SCRIPT_FILES="$SCRIPT_FILES $f"
  SCRIPT_COUNT=$((SCRIPT_COUNT + 1))
done

if [ "$SCRIPT_COUNT" -eq 0 ]; then
  echo "$SCRIPTS_DIR holds no *.sh -- this audit checked nothing" >&2
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

# find_invocations <workflow-or-script-file>
#
# Emits one TSV record per explicit-interpreter invocation found in the
# file, one of:
#   CLEAN<TAB>lineno<TAB>interpreter<TAB>script-path
#   UNPARSEABLE<TAB>lineno<TAB>interpreter-or-"var"<TAB>reason
#
# A trailing `\` line continuation is spliced onto the next physical line
# before matching, so an interpreter and its script split across two lines
# in a `run: |` block (or a script body) are read as one logical line.
# Interpreter flags (`-e`, `-eu`, ...) between the interpreter and the script
# are consumed. A script argument that is a quoted string (the `-c "..."`
# shape) or an interpreter that is a shell variable (`$VAR`, `${VAR}`) is
# reported UNPARSEABLE rather than matched or silently dropped.
#
# Before matching, each logical line is truncated at the first `#` that is
# not inside a quoted string (`strip_unquoted_comment()`), and any candidate
# `sh`/`bash` match that falls inside an open quote at that point
# (`is_quoted_before()`) is dropped rather than emitted. Neither of those
# mattered while this only read workflow YAML; both matter once it also
# reads script bodies, which are full of doc comments and usage/help-text
# string literals shaped exactly like a real invocation (#1681 -- see the
# case matrix in this file's header for real examples of each).
find_invocations() {
  awk '
BEGIN {
  # Single/double quote characters built via sprintf rather than written
  # literally -- this whole program is embedded in a single-quoted shell
  # string (see is_quoted_before()/strip_unquoted_comment() below, which
  # already use the "'"'"'" idiom for the same reason on plain char
  # comparisons); a *regex* containing a literal quote character needs the
  # quote built at runtime instead, so HEREDOC_RE stays a single balanced
  # shell-quoted awk literal with no embedded quote to escape.
  SQ = sprintf("%c", 39)
  DQ = sprintf("%c", 34)
  # Matches a heredoc opener`s "<<" or "<<-", optional whitespace, and a
  # bare/`'"'"'`quoted/"-quoted/backslash-escaped terminator word -- the four
  # shapes real shell scripts use (#1804): `<<EOF`, `<<'"'"'STUB'"'"'`,
  # `<<"JSON"`, `<<-INDENT`, `<<\EOF`. Not anchored to end-of-line so it
  # still matches when a real command precedes it on the same line
  # (`cat <<EOF2` and `TARGET_DIR=.; cat <<EOF2` both match).
  HEREDOC_RE = "<<-?[ \t]*(" SQ "[A-Za-z_][A-Za-z0-9_]*" SQ "|" DQ "[A-Za-z_][A-Za-z0-9_]*" DQ "|\\\\[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)"
  in_heredoc = 0
}

# detect_heredoc(str)
#
# If `str` opens a heredoc (and none is already open), records its
# terminator in the global `heredoc_term` and sets `in_heredoc = 1` so
# subsequent physical lines are treated as literal heredoc body text --
# never scanned for sh/bash invocations -- until the terminator line is
# seen. The terminator match itself strips ALL leading whitespace (spaces
# AND tabs) from the candidate line before comparing, regardless of whether
# the opener used `<<-` (#1817 fix; see "Eighth-pass" header section). This
# is deliberately more lenient than POSIX: a plain `<<TOKEN` heredoc'"'"'s
# terminator is only supposed to close on an EXACT match with no stripping
# at all, and only `<<-` strips (tabs only). This audit is a textual
# approximation, not a shell parser, and the shape that actually recurs in
# this repo'"'"'s own real files is a heredoc opened without `-` whose
# terminator is indented with SPACES to match its surrounding YAML `run: |`
# block or shell function -- YAML'"'"'s block-scalar indentation stripping (or,
# for a script read directly, simple human formatting) makes that terminator
# real at runtime even though the raw text in the file carries a leading
# indent. Treating it as non-matching is what silently swallows every line
# to end-of-file (#1817); treating it as matching costs only the extremely
# narrow risk of an indented heredoc BODY line coincidentally equal to the
# terminator word closing early -- far cheaper than the alternative.
#
# A candidate match is also skipped, and the search continued past it rather
# than opening a fictitious heredoc, when it falls inside an open quote at
# that position (`is_quoted_before()`, same quote-parity check `process()`
# already uses for `sh`/`bash` matches) -- a THIRD way into the same
# stuck-open state, sitting right next to the comment case above: this
# file'"'"'s own test fixtures build heredoc bodies via single-quoted awk/shell
# string literals like `'"'"'cat <<EOF2'"'"'`, where `<<EOF2` is data inside the
# quotes, not a real opener. Reproduced live against
# scripts/interpreter-audit.test.sh'"'"'s own such fixture line (#1817).
function detect_heredoc(str,    rest, offset, consumed, m, abspos) {
  if (in_heredoc) return
  rest = str
  offset = 0
  while (match(rest, HEREDOC_RE)) {
    abspos = offset + RSTART
    consumed = RSTART + RLENGTH - 1
    if (is_quoted_before(str, abspos)) {
      rest = substr(rest, consumed + 1)
      offset += consumed
      continue
    }
    m = substr(rest, RSTART, RLENGTH)
    sub(/^<<-?[ \t]*/, "", m)
    if (substr(m, 1, 1) == SQ || substr(m, 1, 1) == DQ) {
      heredoc_term = substr(m, 2, length(m) - 2)
    } else if (substr(m, 1, 1) == "\\") {
      heredoc_term = substr(m, 2)
    } else {
      heredoc_term = m
    }
    in_heredoc = 1
    return
  }
}

{
  startline = NR
  line = $0

  # A heredoc body is literal text read by the shell until its terminator
  # line, never executed or line-continuation-joined -- so it is excluded
  # from scanning entirely, before comment-stripping or `\`-continuation
  # handling ever sees it (#1804). Checked BEFORE opener-detection so a
  # terminator line itself is consumed here rather than treated as a new
  # command line.
  if (in_heredoc) {
    check_line = line
    sub(/^[ \t]+/, "", check_line)
    if (check_line == heredoc_term) { in_heredoc = 0 }
    next
  }

  # detect_heredoc() runs against the COMMENT-STRIPPED line, not the raw
  # `line` -- a `#`-comment mentioning heredoc syntax in prose (e.g. this
  # very file'"'"'s own header naming `` `<<TOKEN` `` as one of the shapes it
  # handles) is not a real opener, and matching it as one opens a heredoc
  # whose terminator ("TOKEN") never legitimately appears alone on a line,
  # so it never closes -- a second, independent way into the same
  # stuck-open-forever state the whitespace fix above closes (#1817;
  # reproduced live: this exact file and its own test file both hit it via
  # their own documentation of the heredoc shapes this audit handles).
  # `strip_unquoted_comment()` is called here for detection purposes only;
  # `line` itself is untouched so the backslash-continuation join below
  # still sees the raw physical line, matching its existing behaviour.
  detect_heredoc(strip_unquoted_comment(line))

  while (match(line, /\\[ \t]*$/)) {
    if ((getline nextline) <= 0) { sub(/\\[ \t]*$/, "", line); break }
    sub(/\\[ \t]*$/, "", line)
    line = line " " nextline
  }
  line = strip_unquoted_comment(line)
  process(line, startline)
}

# is_quoted_before(str, pos)
#
# True (1) if position `pos` (1-based) in `str` falls inside an open,
# unterminated '"'"'...'"'"' or "..." at that point. Backslash escapes the next
# character everywhere except inside single quotes -- close enough to POSIX
# shell quoting to tell code from prose embedded in the same file (an
# echo/printf/assert_case string literal that happens to contain
# "sh scripts/foo.sh" is not an invocation). Heredocs and quoting that spans
# multiple physical lines are NOT tracked -- each call starts fresh per
# logical line; a documented, accepted gap, not a silent one.
function is_quoted_before(str, pos,    i, n, c, in_s, in_d) {
  in_s = 0; in_d = 0
  n = pos - 1
  i = 1
  while (i <= n) {
    c = substr(str, i, 1)
    if (in_s) {
      if (c == "'"'"'") in_s = 0
      i++
    } else if (in_d) {
      if (c == "\\") { i += 2 }
      else { if (c == "\"") in_d = 0; i++ }
    } else {
      if (c == "\\") { i += 2 }
      else if (c == "'"'"'") { in_s = 1; i++ }
      else if (c == "\"") { in_d = 1; i++ }
      else i++
    }
  }
  return (in_s || in_d)
}

# token_is_truncated(tok)
#
# True (1) if `tok` -- a whitespace-delimited fragment `process()` extracted
# as a candidate script-argument token -- carries syntactic evidence of
# having been cut short mid-construct by that whitespace split, rather than
# being a complete shell word on its own: an unmatched `"`, an unmatched
# single quote, an unmatched `(`, or an unmatched backtick. `"$(dirname`
# (one unclosed `"`, one unclosed `(`) is true; `` `dirname `` (the token
# extracted from `` sh `dirname "$0"`/x.sh ``, one unclosed backtick) is
# true; `foo`, a fully single-quoted word, and `"scripts/foo.sh"` are all
# false. Counts
# are taken via `gsub()` on a throwaway copy of `tok` -- `gsub()` mutates
# its third argument in place, and `tok` is a scalar parameter
# (call-by-value in awk, unlike an array), so this never touches the
# caller'"'"'s string. See the "Ninth-pass" header section (#1809) for why
# quote/paren parity alone is not sufficient and must be paired with a
# `.sh` check on the untruncated remainder, and the "Tenth-pass" section
# (#1826) for why backtick parity had to join the other three counters --
# backtick command substitution truncates the same way `$(...)` does, but
# left no unbalanced quote or paren behind for the first three counters to
# catch.
function token_is_truncated(tok,    c, dq, sq, op, cp, bt) {
  c = tok; dq = gsub(/"/, "", c)
  c = tok; sq = gsub(/'"'"'/, "", c)
  c = tok; op = gsub(/\(/, "", c)
  c = tok; cp = gsub(/\)/, "", c)
  c = tok; bt = gsub(/`/, "", c)
  return (dq % 2 == 1) || (sq % 2 == 1) || (op != cp) || (bt % 2 == 1)
}

# strip_unquoted_comment(str)
#
# Truncates `str` at the first `#` that is not inside a quoted string --
# not just a line whose FIRST character is `#` -- so a doc comment mid-body
# (`foo() { ... }  # sh scripts/bar.sh does X`) is never scanned as code.
function strip_unquoted_comment(str,    i, n, c, in_s, in_d) {
  in_s = 0; in_d = 0
  n = length(str)
  i = 1
  while (i <= n) {
    c = substr(str, i, 1)
    if (in_s) {
      if (c == "'"'"'") in_s = 0
      i++
    } else if (in_d) {
      if (c == "\\") { i += 2 }
      else { if (c == "\"") in_d = 0; i++ }
    } else {
      if (c == "\\") { i += 2 }
      else if (c == "'"'"'") { in_s = 1; i++ }
      else if (c == "\"") { in_d = 1; i++ }
      else if (c == "#") { return substr(str, 1, i - 1) }
      else i++
    }
  }
  return str
}

function process(line, startline,    rest, matched, interp, wordend, tail, tail2, token, vline,    consumed, flaglen, wslen, toklen, vconsumed, offset, voffset, abspos, interp_rstart) {
  rest = line
  offset = 0
  while (match(rest, /(^|[ \t])(sh|bash)([ \t]|$)/)) {
    # Captured the instant this match() returns -- see the #1625 comment
    # below on `consumed` for why: the flag-skip and token-extraction
    # match() calls a few lines down overwrite the same RSTART/RLENGTH this
    # one just set, and abspos (added for #1681) needs the ORIGINAL match
    # position, not whatever match() left behind last.
    interp_rstart = RSTART
    matched = substr(rest, RSTART, RLENGTH)
    if (matched ~ /^bash/)      { interp = "bash"; wordend = RSTART + 4 - 1 }
    else if (matched ~ /^sh/)   { interp = "sh";   wordend = RSTART + 2 - 1 }
    else if (matched ~ /^[ \t]bash/) { interp = "bash"; wordend = RSTART + 1 + 4 - 1 }
    else                        { interp = "sh";   wordend = RSTART + 1 + 2 - 1 }

    # `consumed` tracks, in characters of `rest`, how far the invocation just
    # parsed extends -- it is what `rest` gets advanced by below. It must be
    # built from lengths captured the instant each match() returns, never
    # from RSTART/RLENGTH read back later: awk has exactly one set of those
    # globals, so the flag-skip and token-extraction match() calls below
    # silently overwrite whatever the interpreter match() left there (#1625).
    # Reusing a stale RSTART/RLENGTH -- as this function used to, on its
    # final `rest = substr(rest, RSTART + RLENGTH)` -- advances `rest` by an
    # offset that belongs to a short inner string (`tail`/`tail2`), not to
    # `rest` itself, leaving residue that gets rescanned as a phantom second
    # invocation. Where the residue lands depends on the interpolated
    # script-path length, which is why the outward symptom tracked filename
    # length.
    consumed = wordend

    tail = substr(rest, wordend + 1)
    while (match(tail, /^[ \t]+-[^ \t]*/)) {
      flaglen = RLENGTH
      tail = substr(tail, flaglen + 1)
      consumed += flaglen
    }

    token = ""
    if (match(tail, /^[ \t]+/)) {
      wslen = RLENGTH
      tail2 = substr(tail, wslen + 1)
      if (match(tail2, /^[^ \t]+/)) {
        toklen = RLENGTH
        token = substr(tail2, RSTART, RLENGTH)
        consumed += wslen + toklen
      } else {
        consumed += wslen
      }
    }

    # The interpreter word itself may sit inside a quoted string this audit
    # has no business treating as code -- a usage comment turned into help
    # text (`echo "... sh scripts/foo.sh ..."`), a notify-send message, an
    # assert_case scenario label. Quote parity is computed against the WHOLE
    # logical `line`, not `rest` -- `rest` has already had earlier
    # invocations sliced off the front, which would lose any quote opened
    # before the slice point (#1681; see is_quoted_before()).
    abspos = offset + interp_rstart
    if (!is_quoted_before(line, abspos)) {
      if (token != "" && token ~ /^[^ \t"$]+\.sh$/) {
        printf "CLEAN\t%d\t%s\t%s\n", startline, interp, token
      } else if (token != "" && index(token, ".sh") > 0) {
        printf "UNPARSEABLE\t%d\t%s\tinvoked with %s, target is not a bare script path: %s\n", startline, interp, interp, token
      } else if (token != "" && token_is_truncated(token) && index(tail2, ".sh") > 0) {
        # #1809: `token` is only the first whitespace-delimited chunk of a
        # longer quoted/command-substitution argument, cut short before its
        # own `.sh` suffix -- e.g. `"$(dirname` from `sh "$(dirname
        # "$0")/x.sh"`. Neither branch above can match a fragment; falling
        # through here silently would be the fourth, uncounted state this
        # audit'"'"'s own invariant forbids. `tail2` (not `token`) is checked for
        # `.sh` because it is the untruncated remainder of the line.
        printf "UNPARSEABLE\t%d\t%s\tinvoked with %s, target argument was truncated by internal whitespace (quoted/command-substitution expression), could not resolve: %s\n", startline, interp, interp, token
      }
    }

    rest = substr(rest, consumed + 1)
    offset += consumed
  }

  vline = line
  voffset = 0
  while (match(vline, /(^|[ \t])\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[ \t]+[^ \t]+\.sh([ \t]|$)/)) {
    vconsumed = RSTART + RLENGTH
    if (!is_quoted_before(line, voffset + RSTART)) {
      printf "UNPARSEABLE\t%d\tvar\tinterpreter is a shell variable, cannot be resolved statically\n", startline
    }
    vline = substr(vline, vconsumed)
    voffset += vconsumed
  }
}
' "$1"
}

match_count=0
mismatch_count=0
unparseable_count=0

for f in $WF_FILES $SCRIPT_FILES; do
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
printf 'interpreter audit: checked %s workflow file(s) and %s script file(s), %s explicit-interpreter invocation(s) found\n' \
  "$WF_COUNT" "$SCRIPT_COUNT" "$total"
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
