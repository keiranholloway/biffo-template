#!/usr/bin/env sh
#
# scripts/biffo.sh must resolve the CLI pin from the index while a merge is in
# progress (MERGE_HEAD set), so a merged-in newer biffo.core.json is the CLI that
# runs the commit hooks; otherwise from HEAD. A stub `npx` reports the version.
#
# Run: sh scripts/biffo-sh-merge-pin.test.sh

set -u
here=$(cd "$(dirname "$0")" && pwd)
src="$here/biffo.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
FAILURES=0

mkdir "$tmp/bin"
cat > "$tmp/bin/npx" <<'S'
#!/bin/sh
echo "npx-called: $*"
S
chmod +x "$tmp/bin/npx"

git_() { git -C "$tmp/repo" -c user.email=t@t -c user.name=t -c commit.gpgsign=false "$@"; }
pin() { printf '{"version":"%s"}\n' "$1" > "$tmp/repo/biffo.core.json"; }
run() { (cd "$tmp/repo" && PATH="$tmp/bin:$PATH" sh scripts/biffo.sh x 2>&1); }
check() {
  case "$2" in
    *"@biffo/cli@$1 "*|*"@biffo/cli@$1") echo "ok - $3" ;;
    *) echo "FAIL - $3: wanted $1, got: $2"; FAILURES=$((FAILURES + 1)) ;;
  esac
}

mkdir -p "$tmp/repo/scripts"
cp "$src" "$tmp/repo/scripts/biffo.sh"
git_ init -q -b main
pin 0.396.0
git_ add -A
git_ commit -qm base
git_ checkout -qb dev
pin 0.409.0
git_ commit -qam newer
git_ checkout -q main
echo b > "$tmp/repo/other"
git_ add -A
git_ commit -qm branch

check 0.396.0 "$(run)" "no merge: HEAD's pin"

git_ merge --no-commit --no-ff dev >/dev/null 2>&1
if git_ rev-parse -q --verify MERGE_HEAD >/dev/null; then
  check 0.409.0 "$(run)" "merge in progress: staged pin"
else
  echo "FAIL - merge did not leave MERGE_HEAD"; FAILURES=$((FAILURES + 1))
fi
git_ merge --abort

[ "$FAILURES" -eq 0 ] || exit 1
