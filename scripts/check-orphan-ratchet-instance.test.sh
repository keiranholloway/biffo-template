#!/usr/bin/env sh
#
# Proves scripts/check-orphan-ratchet-instance.sh actually closes the gap
# biffo-template#1714's second prosecutor verdict found: nothing in any live
# instance's own PR-time CI could ever find a real orphan, because the only
# step wired in (`sh scripts/biffo.sh check orphan-ratchet`, no args) is a
# self-check that can only ever report zero.
#
# Two real, throwaway git repos stand in for "the template at a pinned
# version" and "a live instance" -- no mocking of git, planCoreUpgrade or
# classify(): the property under test is whether the WRAPPER resolves the
# right tag, clones it, and passes it through to the REAL production check
# logic (`runOrphanRatchetCheck` via `checkCommand`), so a mock of that logic
# would just assert whatever the mock author assumed rather than what the
# real guard actually does with a real diverged tree. This is the same
# "real git, not a mock" discipline scripts/allocate-module-number.test.sh
# uses and for the same reason.
#
# The fixture "instance"'s own scripts/biffo.sh does not exec `npx
# @biffo/cli@<version>` (the real dispatcher) -- that would need a published
# npm version carrying this exact CLI code, which does not exist yet for an
# unreleased change under test. It execs THIS repo's own already-built local
# CLI via tsx directly (BIFFO_TEMPLATE_GIT_URL and this substitution are the
# only two seams the production script exposes for testing, deliberately --
# see check-orphan-ratchet-instance.sh's own header). That still exercises
# the real `checkCommand` -> `runOrphanRatchetCheck` -> `planCoreUpgrade`/
# `classify()` path end to end; only the version-pin-to-npm-package hop
# (scripts/biffo.sh's own concern, unchanged by this PR) is substituted.
#
# Repo-local scratch (never /tmp for the SCRATCH DIR itself -- the fixture
# repos below are a handful of files each, not a copy of a large working
# tree, so cloning them into a temp dir is not the tmpfs-inode hazard
# AGENTS.md warns about; the scratch dir holding the fixtures is kept
# repo-local anyway, matching allocate-module-number.test.sh's own
# precedent).
#
# ## This script's own template-vs-instance gate (#1897)
#
# ci.yml wires this SELF-TEST as an unconditional step ("Orphan-ratchet guard
# (instance mode) self-test"), gated only on `pnpm install` having succeeded
# -- and ci.yml itself is template-owned, so `biffo core upgrade` carries that
# step verbatim into every instance. This script needs a locally-built
# `cli/node_modules/.bin/tsx` to exercise the real CLI (see the header above),
# but `cli/` is declared `"released"` in core-manifest.json, not
# `templateOwned` or `userOwned` -- it is published to npm and deliberately
# NEVER distributed into an instance's tree (confirmed live: tabsii-platform
# on core 0.302.1+ carries no `cli/` directory at all, not merely an unbuilt
# one). Treating that as a FAIL made this step structurally unpassable in
# every instance, forever, from the moment core 0.302.1 landed.
#
# `cli/` presence is therefore the right discriminator for THIS script
# specifically (it is what the failure actually depends on), and it agrees
# with this repo's other canonical instance marker: an instance always
# carries `biffo.core.json` (`isInstanceRepo()`,
# `cli/src/lib/core-version.ts`, and this same script's own production
# counterpart `check-orphan-ratchet-instance.sh` already skips -- exit 0, a
# genuine skip, not "cannot tell" -- when THAT file is absent, for the exact
# same template-vs-instance reason). Absence of `cli/` is a genuine skip here
# for the same reason: there is nothing wrong to report, only nothing this
# checkout can self-test.
#
# Run: sh scripts/check-orphan-ratchet-instance.test.sh

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
WRAPPER="$REPO_ROOT/scripts/check-orphan-ratchet-instance.sh"
TSX="$REPO_ROOT/cli/node_modules/.bin/tsx"
CLI_ENTRY="$REPO_ROOT/cli/src/index.ts"

fail=0
report() {
  echo "FAIL: $1" >&2
  fail=1
}

# =============================================================================
# The real gate: an instance carries no cli/ (see the doc comment above) --
# skip cleanly rather than failing on a directory that was never meant to be
# here. This MUST run before the meta-test below: the meta-test invokes a
# copy of this very file from a scratch root with no cli/, and that copy
# needs to hit this gate and exit immediately, not fall through into its own
# nested meta-test (which would recurse without ever terminating).
# =============================================================================

if [ ! -d "$REPO_ROOT/cli" ]; then
  echo "SKIP: $REPO_ROOT/cli is absent -- this is an instance, not the template (cli/ is" >&2
  echo "'released' in core-manifest.json: published to npm, never distributed via biffo core" >&2
  echo "upgrade). There is no local CLI/tsx here to self-test against. Genuine skip (exit 0)," >&2
  echo "not a failure -- see this script's own doc comment for why." >&2
  exit 0
fi

if [ ! -x "$TSX" ]; then
  echo "FAIL: $TSX is not present/executable -- run 'pnpm install' in $REPO_ROOT first (this" >&2
  echo "test exercises the real CLI, not a reimplementation of it)." >&2
  exit 1
fi

# =============================================================================
# 0. Meta-test: prove the skip gate above actually skips, by running a real
#    copy of THIS script from a scratch root that has no cli/ -- not a
#    reimplementation of the guard clause, the actual file. This is the only
#    practical way to exercise the "instance context" path for a shell
#    preamble: there is no live instance checkout to point this at from the
#    template's own CI, so simulate the one structural fact that matters
#    (cli/ is absent) and confirm the guard above reacts to it. Only reached
#    once we know (from the gate just above) that THIS run has a real cli/ --
#    so the nested copy hits its OWN gate first, with no cli/ under its
#    scratch root, and exits there without ever reaching this block again.
# =============================================================================

skip_meta_work=$(mktemp -d "$REPO_ROOT/.check-orphan-ratchet-instance-test-skip-XXXXXX")
mkdir -p "$skip_meta_work/scripts"
cp "$REPO_ROOT/scripts/check-orphan-ratchet-instance.test.sh" "$skip_meta_work/scripts/"

skip_out=$(sh "$skip_meta_work/scripts/check-orphan-ratchet-instance.test.sh" 2>&1)
skip_rc=$?
rm -rf "$skip_meta_work"

if [ "$skip_rc" -ne 0 ]; then
  report "running this test script from a root with no cli/ was expected to exit 0 (genuine" \
    "skip) -- got $skip_rc: $skip_out"
fi
case "$skip_out" in
  *"cli is absent"*) ;;
  *) report "the no-cli/ skip did not log a clear, named reason -- got: $skip_out" ;;
esac
case "$skip_out" in
  *"PASS: instance-mode orphan-ratchet check"*)
    report "the no-cli/ run reached the normal success banner instead of skipping early -- the" \
      "guard clause did not fire: $skip_out"
    ;;
  *) ;;
esac

WORK=$(mktemp -d "$REPO_ROOT/.check-orphan-ratchet-instance-test-XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

git_c() {
  # A CI runner carries no global git identity; workstation .gitconfig
  # should not leak into the fixture either. Explicit identity every time,
  # same reasoning as allocate-module-number.test.sh's make_fixture().
  git -c user.email=t@example.invalid -c user.name=t "$@"
}

# --- Fixture: "the template" -- a real git repo with a core-manifest.json
# declaring scripts/ template-owned, one real tracked file under scripts/,
# tagged core-v0.1.0. ---------------------------------------------------
make_template_fixture() {
  dir="$1"
  mkdir -p "$dir/scripts"
  (
    cd "$dir" &&
    git init --quiet &&
    printf '%s\n' \
      '{' \
      '  "version": 1,' \
      '  "templateOwned": ["scripts/"],' \
      '  "userOwned": []' \
      '}' > core-manifest.json &&
    echo '#!/usr/bin/env sh' > scripts/real-template-file.sh &&
    # A real instance's own scripts/biffo.sh is TEMPLATE-owned content it
    # received via distribution, not instance-written drift -- so the
    # template fixture must carry the same path too, or the fixture itself
    # (not the code under test) manufactures a false "unsanctioned" finding
    # for every instance fixture below, the same way a real one never would.
    echo '#!/usr/bin/env sh' > scripts/biffo.sh &&
    git add -A &&
    git_c commit --quiet -m 'seed template fixture' &&
    git tag core-v0.1.0
  )
}

# --- Fixture: "an instance" -- a real git repo carrying biffo.core.json
# pinned to 0.1.0, a scripts/biffo.sh stand-in that runs the REAL local CLI,
# and (per case) an unsanctioned file under scripts/ plus an orphan baseline.
# ------------------------------------------------------------------------
make_instance_fixture() {
  dir="$1"
  baseline_count="$2"
  add_unsanctioned="$3"
  mkdir -p "$dir/scripts"
  cat > "$dir/scripts/biffo.sh" <<EOF
#!/usr/bin/env sh
exec "$TSX" "$CLI_ENTRY" "\$@"
EOF
  chmod +x "$dir/scripts/biffo.sh"
  printf '{\n  "version": "0.1.0"\n}\n' > "$dir/biffo.core.json"
  if [ -n "$baseline_count" ]; then
    printf '{\n  "count": %s\n}\n' "$baseline_count" > "$dir/biffo.orphan-baseline.json"
  fi
  if [ "$add_unsanctioned" = "yes" ]; then
    echo '#!/usr/bin/env sh' > "$dir/scripts/fake-unsanctioned-test-1714.sh"
  fi
  (
    cd "$dir" &&
    git init --quiet &&
    git add -A &&
    git_c commit --quiet -m 'seed instance fixture'
  )
}

template_fixture="$WORK/template-fixture"
make_template_fixture "$template_fixture"

# =============================================================================
# 1. FAIL-FIRST: an instance with an unsanctioned file under scripts/, a
#    recorded baseline of 0, checked against the real pinned template ->
#    exits non-zero, names the file, and names the sanctioned-carve-out
#    guidance (or the "belongs upstream" alternative when none is nearby).
# =============================================================================

dirty_instance="$WORK/dirty-instance"
make_instance_fixture "$dirty_instance" 0 yes

out=$(cd "$dirty_instance" && BIFFO_TEMPLATE_GIT_URL="file://$template_fixture" sh "$WRAPPER" 2>&1)
rc=$?

echo "--- dirty instance run (exit $rc) ---"
echo "$out"
echo "--- end ---"

if [ "$rc" -eq 0 ]; then
  report "an instance carrying an unsanctioned scripts/fake-unsanctioned-test-1714.sh, with a" \
    "recorded baseline of 0, was expected to exit non-zero against the real pinned template -- got 0."
fi

case "$out" in
  *fake-unsanctioned-test-1714.sh*) ;;
  *) report "the failure output does not name the actual unsanctioned file (fake-unsanctioned-test-1714.sh) -- an author reading this CI failure would not know what to move." ;;
esac

case "$out" in
  *"core capability"*"belongs upstream"*|*"sanctioned carve-out"*) ;;
  *) report "the failure output does not distinguish 'should be upstream' from 'should be in a carve-out' -- #1714's own Recommendation section requires this." ;;
esac

# =============================================================================
# 2. A clean instance (no unsanctioned files, tree matches the pinned
#    template exactly) -> exits 0.
# =============================================================================

clean_instance="$WORK/clean-instance"
make_instance_fixture "$clean_instance" "" no
# Give the clean instance the SAME tracked file the template ships, so
# oursDir/theirsDir/baseDir agree exactly and classify() has nothing to flag
# -- a genuinely clean tree, not merely one nobody looked at.
cp "$template_fixture/scripts/real-template-file.sh" "$clean_instance/scripts/real-template-file.sh"
( cd "$clean_instance" && git add -A && git_c commit --quiet -m 'match template tree' )

out=$(cd "$clean_instance" && BIFFO_TEMPLATE_GIT_URL="file://$template_fixture" sh "$WRAPPER" 2>&1)
rc=$?

echo "--- clean instance run (exit $rc) ---"
echo "$out"
echo "--- end ---"

if [ "$rc" -ne 0 ]; then
  report "a clean instance (tree matches the pinned template exactly) was expected to exit 0 -- got $rc: $out"
fi

# =============================================================================
# 3. Not an instance at all (no biffo.core.json) -> exit 0, a genuine skip
#    (this is the template itself, or scripts/verify.sh's own local run of
#    THIS repo's gate) -- distinct from "cannot tell" (see the script's own
#    doc comment for why this is 0 rather than 2: the same distinction
#    check-orphan-ratchet.ts already draws between an omitted --instance-dir
#    and one explicitly given but broken).
# =============================================================================

not_instance="$WORK/not-instance"
mkdir -p "$not_instance"
( cd "$not_instance" && git init --quiet && git_c commit --quiet --allow-empty -m seed )

out=$(cd "$not_instance" && sh "$WRAPPER" 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
  report "a checkout with no biffo.core.json was expected to exit 0 (genuine skip, not 'cannot tell') -- got $rc: $out"
fi

# =============================================================================
# 4. A tag that does not exist (instance pinned to a version the template
#    fixture never tagged) -> exit 2, cannot tell, not a false pass.
# =============================================================================

unknown_tag_instance="$WORK/unknown-tag-instance"
make_instance_fixture "$unknown_tag_instance" 0 no
# Overwrite the version to something the template fixture has no tag for.
printf '{\n  "version": "9.9.9"\n}\n' > "$unknown_tag_instance/biffo.core.json"
( cd "$unknown_tag_instance" && git add -A && git_c commit --quiet -m 'bump to untagged version' )

out=$(cd "$unknown_tag_instance" && BIFFO_TEMPLATE_GIT_URL="file://$template_fixture" sh "$WRAPPER" 2>&1)
rc=$?
if [ "$rc" -ne 2 ]; then
  report "an instance pinned to a version with no matching core-v* tag was expected to exit 2 (cannot tell) -- got $rc: $out"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "PASS: instance-mode orphan-ratchet check (real git fixtures, real CLI) --"
echo "      finds a real unsanctioned file and names it plus the upstream/carve-out"
echo "      guidance, passes a genuinely clean instance, skips (exit 0) when it is"
echo "      not an instance at all, and fails closed (exit 2) on a version with no"
echo "      matching template tag."
exit 0
