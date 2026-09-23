#!/usr/bin/env sh
#
# Proves the plugin-staleness filing step files each finding into the repo
# that must do the work, and never into the repo that detected it (#2076).
#
# ## What went wrong
#
# `.github/workflows/plugin-staleness-report.yml` built a per-(instance,
# plugin) issue whose remedy is `cd <instance> && npx @biffo/cli plugin
# upgrade ...`, then ran `gh issue create` with no `--repo`. `gh` defaults to
# the repository the job runs in, so every one of those issues landed in
# biffo-template -- the one repo where that remedy cannot be run. Three were
# live when this was found (biffo-template#2068/#2069/#2070, for
# biffo-platform and tabsii-platform), each the ONLY record of its work,
# sitting where nobody could act on it. `categorise` then read the filing
# location as the work location and labelled them `lane:in-repo`, so they
# were offered as dispatchable biffo-template work and sat at score 0 forever.
#
# ## Why this test executes the step rather than grepping it
#
# A grep for `--repo` would pass against a step that passes `--repo
# "$GITHUB_REPOSITORY"`, which is the defect restated. The property under
# test is WHICH repo each call names for a given finding, so the step's own
# script is extracted from the workflow and run, with `gh` stubbed to record
# every invocation (and the token it was handed). Everything between the
# findings record and the `gh` argv -- the owner parse, the token selection,
# the dedup, the fail-closed paths -- is the real shipped code.
#
# Two seams are substituted, both unavoidable and both narrow:
#   1. `${{ steps.check.outputs.findings }}` is a GitHub expression, not
#      shell; it is replaced with a path to this test's fixture.
#   2. `gh` is a stub on PATH. Nothing else is mocked -- `node` is the real
#      node, which is why this guard is wired into ci.yml's js job rather
#      than left to guard-self-test-wiring.sh's python-job sweep.
#
# The extracted step runs under bash with errexit on, because that is
# GitHub's default shell for a `run:` block with no `shell:` key (`bash -e
# {0}`), and the difference matters: under errexit a bare
# `var=$(failing-cmd)` kills the step outright, so an rc check written after
# one is unreachable. Running it under plain `sh`, or without `-e`, would
# test a laxer interpreter than production uses.
#
# Errexit is applied by prepending `#!/usr/bin/env bash` + `set -e` to the
# extracted file and executing it directly, rather than by invoking `bash -e
# <path>`. Same semantics; the reason for the indirection is
# scripts/interpreter-audit.sh, which fails closed on any `sh`/`bash`
# invocation whose target it cannot statically resolve to a `scripts/*.sh`
# file -- and a path in a variable pointing at a generated temp file never
# can be. Teaching that audit to wave through variable targets would blunt
# it for every caller to suit this one; a shebang costs nothing and leaves
# it nothing to misresolve.

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
workflow="$here/.github/workflows/plugin-staleness-report.yml"
[ -f "$workflow" ] || { echo "FAIL: no $workflow" >&2; exit 1; }

command -v node >/dev/null 2>&1 || {
  echo "FAIL: node is required -- this guard runs the step's real JSON parsing, not a stub of it" >&2
  exit 1
}

work=$(mktemp -d "${TMPDIR:-/tmp}/plugin-staleness-target-repo.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

DETECTOR="keiranholloway/biffo-template"

# Wrap an extracted `run:` block so it executes the way GitHub executes it:
# `bash` with errexit, which is the default shell for a `run:` with no
# `shell:` key. `-u` as well because both blocks extracted here come from
# steps that open with `set -u` -- the filing step carries its own copy in
# the extracted text and re-declaring it is a no-op; the discovery fragment
# is taken from the middle of its step, below that line, and would otherwise
# be tested more permissively than it runs.
as_github_step() {
  printf '#!/usr/bin/env bash\nset -eu\n' > "$1.exec"
  cat "$1" >> "$1.exec"
  mv "$1.exec" "$1"
  chmod +x "$1"
}


# ---------------------------------------------------------------- extraction
# Take the filing step's `run:` block: from the `run: |` that follows the
# step's name, to the first line at or below the step's own indentation.
awk '
  /^      - name: Open or update one issue per stale \(instance, plugin\) pair$/ { instep = 1; next }
  instep && !inrun && /^        run: \|$/ { inrun = 1; next }
  inrun {
    if ($0 !~ /^[ \t]*$/ && $0 !~ /^          /) exit
    sub(/^          /, "")
    print
  }
' "$workflow" > "$work/step.sh"

for anchor in 'gh issue create' 'gh issue list' 'instanceRepo'; do
  grep -q -- "$anchor" "$work/step.sh" || {
    echo "FAIL: extraction produced a script with no '$anchor' in it -- the step's shape in the workflow changed and this guard is no longer reading it" >&2
    exit 1
  }
done

sed 's|\${{ steps.check.outputs.findings }}|'"$work"'/findings.jsonl|g' \
  "$work/step.sh" > "$work/step.run.sh"
grep -q '\${{' "$work/step.run.sh" && {
  echo "FAIL: an unsubstituted \${{ }} expression is left in the extracted step:" >&2
  grep -n '\${{' "$work/step.run.sh" >&2
  exit 1
}
as_github_step "$work/step.run.sh"

# ------------------------------------------------------------------ gh stub
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env sh
# Records every invocation as: <token-label> <tab> <args...>
label='NO-TOKEN'
case "${GH_TOKEN:-}" in
  tok-keiranholloway) label='KH' ;;
  tok-tabsii-com) label='TABSII' ;;
  '') label='EMPTY' ;;
  *) label="OTHER(${GH_TOKEN})" ;;
esac
printf '%s\t%s\n' "$label" "$*" >> "$GH_LOG"

repo=''
prev=''
for a in "$@"; do
  [ "$prev" = '--repo' ] && repo="$a"
  prev="$a"
done

case "$1 $2" in
  'issue list')
    if [ -n "${FAKE_OPEN_IN:-}" ] && [ "$repo" = "$FAKE_OPEN_IN" ]; then
      echo "${FAKE_OPEN_NUMBER:-7}"
    fi
    ;;
  'issue create') echo "https://github.com/${repo}/issues/101" ;;
esac
exit 0
STUB
chmod +x "$work/bin/gh"

# ------------------------------------------------------------------- runner
# Runs the extracted step against a findings fixture. Sets GH_LOG per case.
run_step() {
  GH_LOG="$work/gh.log"; : > "$GH_LOG"
  rc=0
  env -u GH_TOKEN \
    PATH="$work/bin:$PATH" \
    GH_LOG="$GH_LOG" \
    FAKE_OPEN_IN="${FAKE_OPEN_IN:-}" \
    FAKE_OPEN_NUMBER="${FAKE_OPEN_NUMBER:-}" \
    GITHUB_REPOSITORY="$DETECTOR" \
    GITHUB_SERVER_URL="https://github.com" \
    GITHUB_RUN_ID="12345" \
    TOKEN_KEIRANHOLLOWAY="tok-keiranholloway" \
    TOKEN_TABSII_COM="tok-tabsii-com" \
    "$work/step.run.sh" > "$work/out.txt" 2>&1 || rc=$?
  return "$rc"
}


finding() {
  # finding <instance> <instanceRepo> <plugin>
  printf '{"instance":"%s","instanceRepo":%s,"name":"%s","status":"behind","detail":"3 commits behind","source":"https://github.com/keiranholloway/biffo-plugin-%s.git"}\n' \
    "$1" "$2" "$3" "$3"
}

fails=0
check() {
  # check <description> <condition-result>
  if [ "$2" = 0 ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1"
    fails=$((fails + 1))
  fi
}
logged() { grep -qF -- "$1" "$work/gh.log"; }

# ============================================================== case 1 + 2 + 3
echo "case: a finding is filed into its own repo, with that account's token"
{
  finding biffo-platform '"keiranholloway/biffo-platform"' idea-scout
  finding tabsii-platform '"tabsii-com/tabsii-platform"' marketing
} > "$work/findings.jsonl"
FAKE_OPEN_IN='' FAKE_OPEN_NUMBER='' run_step || {
  echo "FAIL: step exited non-zero on two well-formed findings" >&2
  cat "$work/out.txt" >&2; exit 1
}

check "creates in keiranholloway/biffo-platform" \
  "$(logged 'issue create --repo keiranholloway/biffo-platform' && echo 0 || echo 1)"
check "creates in tabsii-com/tabsii-platform" \
  "$(logged 'issue create --repo tabsii-com/tabsii-platform' && echo 0 || echo 1)"
check "never creates in the detecting repo ($DETECTOR)" \
  "$(logged "issue create --repo $DETECTOR" && echo 1 || echo 0)"
check "never creates without --repo at all" \
  "$(grep -E 'issue create( |$)' "$work/gh.log" | grep -qv -- '--repo' && echo 1 || echo 0)"
check "dedup lists keiranholloway/biffo-platform, not the detector" \
  "$(logged 'issue list --repo keiranholloway/biffo-platform' && echo 0 || echo 1)"
check "the tabsii-com write is made with the tabsii-com token" \
  "$(grep -F 'issue create --repo tabsii-com/tabsii-platform' "$work/gh.log" | grep -q '^TABSII' && echo 0 || echo 1)"
check "the keiranholloway write is made with the keiranholloway token" \
  "$(grep -F 'issue create --repo keiranholloway/biffo-platform' "$work/gh.log" | grep -q '^KH' && echo 0 || echo 1)"
check "no gh call runs with an ambient/absent token" \
  "$(grep -qE '^(NO-TOKEN|EMPTY)	' "$work/gh.log" && echo 1 || echo 0)"

# ==================================================================== case 4
echo "case: a pre-#2076 original in the detecting repo is moved, not forked"
finding biffo-platform '"keiranholloway/biffo-platform"' idea-scout > "$work/findings.jsonl"
FAKE_OPEN_IN="$DETECTOR" FAKE_OPEN_NUMBER=2068 run_step || {
  echo "FAIL: step exited non-zero while moving an original" >&2
  cat "$work/out.txt" >&2; exit 1
}
check "closes the wrongly-filed original in the detecting repo" \
  "$(logged "issue close 2068 --repo $DETECTOR" && echo 0 || echo 1)"
check "reports the move" \
  "$(grep -q "moved $DETECTOR#2068" "$work/out.txt" && echo 0 || echo 1)"
check "still filed the real issue in the instance repo" \
  "$(logged 'issue create --repo keiranholloway/biffo-platform' && echo 0 || echo 1)"

# ==================================================================== case 5
echo "case: a finding with no target repo fails the run instead of filing here"
finding biffo-platform 'null' idea-scout > "$work/findings.jsonl"
FAKE_OPEN_IN='' FAKE_OPEN_NUMBER='' run_step && {
  echo "FAIL: step exited 0 on a finding with no instanceRepo" >&2; exit 1
} || true
check "no issue is created anywhere" \
  "$(grep -qE 'issue create' "$work/gh.log" && echo 1 || echo 0)"
check "says why it refused" \
  "$(grep -q 'no target repo' "$work/out.txt" && echo 0 || echo 1)"

# ==================================================================== case 6
echo "case: an owner with no minted token fails the run instead of filing here"
finding other-thing '"some-other-org/other-thing"' idea-scout > "$work/findings.jsonl"
FAKE_OPEN_IN='' FAKE_OPEN_NUMBER='' run_step && {
  echo "FAIL: step exited 0 on an owner with no write identity" >&2; exit 1
} || true
check "no issue is created anywhere" \
  "$(grep -qE 'issue create' "$work/gh.log" && echo 1 || echo 0)"
check "names the unreachable owner" \
  "$(grep -q 'some-other-org' "$work/out.txt" && echo 0 || echo 1)"

# ==================================================================== case 7
# The filing step above can only file into the right repo if `instanceRepo`
# actually arrives in the findings record. That is produced two steps
# earlier, so the chain is closed here rather than assumed: the check step's
# tagger is extracted and run against a real CLI-shaped result.
echo "case: the check step tags each finding with its instance's owner/name slug"
sed -n "/One JSON line per (instance, plugin) result/,/>> \"\$findings\"/p" \
  "$workflow" | sed -n "/node -e '/,/^ *'/p" \
  | sed "1s/.*node -e '//" | sed '$ s/^ *'"'"'.*//' > "$work/tagger.mjs"
grep -q 'instanceRepo' "$work/tagger.mjs" || {
  echo "FAIL: could not extract a tagger emitting instanceRepo from the check step" >&2
  exit 1
}
tagged=$(printf '[{"name":"idea-scout","status":"behind"}]' \
  | node -e "$(cat "$work/tagger.mjs")" biffo-platform keiranholloway/biffo-platform)
check "tagger emits the instance's full slug as instanceRepo" \
  "$(printf '%s' "$tagged" | grep -q '"instanceRepo":"keiranholloway/biffo-platform"' && echo 0 || echo 1)"
check "tagger still emits the bare instance name for display" \
  "$(printf '%s' "$tagged" | grep -q '"instance":"biffo-platform"' && echo 0 || echo 1)"

# ==================================================================== case 8
# And the slug only reaches the check step if discovery writes it. The loop
# that builds instances.txt is extracted and RUN against a fixture estate --
# a grep would not do here: the first draft of this case grepped the
# workflow for `done < "$candidates.filtered"`, which also matches the
# CLONING loop a few lines above, so it passed against a mutant that had
# been reverted to globbing the clone directories. Executing it is what
# makes the difference between instances.txt carrying `owner/name` and
# carrying a bare directory name observable.
echo "case: discovery writes owner/name slugs into instances.txt"
awk '
  /^          : > "\$RUNNER_TEMP\/instances.txt"$/ { on = 1 }
  on {
    line = $0
    sub(/^          /, "", line)
    print line
    # Tested on the DEDENTED copy, and only after printing: an earlier draft
    # matched /^          done/ against $0 after sub() had already stripped
    # that indent from it, so the loop never terminated the extraction and
    # the whole rest of the step came along with it.
    if (line ~ /^done/) exit
  }
' "$workflow" > "$work/discover.sh"
grep -q 'instances.txt' "$work/discover.sh" || {
  echo "FAIL: could not extract the instances.txt loop from the discovery step" >&2
  exit 1
}

est="$work/estate"
mkdir -p "$est/biffo-platform" "$est/tabsii-platform" "$est/biffo-plugin-idea-scout"
echo '{}' > "$est/biffo-platform/biffo.core.json"
echo '{}' > "$est/tabsii-platform/biffo.core.json"
# a plugin repo: correctly excluded, not a miss
cat > "$work/cands.filtered" <<'CANDS'
keiranholloway/biffo-platform
tabsii-com/tabsii-platform
keiranholloway/biffo-plugin-idea-scout
CANDS
mkdir -p "$work/rt"
as_github_step "$work/discover.sh"
env ESTATE="$est" RUNNER_TEMP="$work/rt" candidates="$work/cands" \
  "$work/discover.sh" > "$work/discover.out" 2>&1 || {
    echo "FAIL: the extracted discovery loop exited non-zero" >&2
    cat "$work/discover.out" >&2
    exit 1
  }
got=$(cat "$work/rt/instances.txt" 2>/dev/null || true)
check "instances.txt carries keiranholloway/biffo-platform, not 'biffo-platform'" \
  "$(printf '%s\n' "$got" | grep -qx 'keiranholloway/biffo-platform' && echo 0 || echo 1)"
check "instances.txt carries the cross-org slug too" \
  "$(printf '%s\n' "$got" | grep -qx 'tabsii-com/tabsii-platform' && echo 0 || echo 1)"
check "a repo with no biffo.core.json is still excluded" \
  "$(printf '%s\n' "$got" | grep -q 'idea-scout' && echo 1 || echo 0)"
check "no bare directory name is written" \
  "$(printf '%s\n' "$got" | grep -v '^$' | grep -qv '/' && echo 1 || echo 0)"

check "the check step reads a slug and derives the bare name from it" \
  "$(grep -q 'name="${slug##\*/}"' "$workflow" && echo 0 || echo 1)"

echo
if [ "$fails" -ne 0 ]; then
  echo "plugin-staleness target-repo guard: $fails assertion(s) FAILED" >&2
  exit 1
fi
echo "plugin-staleness target-repo guard: all assertions passed"
