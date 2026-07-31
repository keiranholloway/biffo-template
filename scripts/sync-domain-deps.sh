#!/bin/sh
#
# Install the Python dependencies an instance's product domains declare (#891).
#
# ADR-0022 gives an instance's own product-domain code a user-owned home at
# `services/api/src/api/domains/<name>/`, but `services/api/pyproject.toml` is
# template-owned — so until now a domain that needed a package the template does
# not ship had to fork that manifest. This is the mechanism that replaces the
# fork. `scripts/domain_requirements.py` documents the design in full; the two
# load-bearing properties are:
#
#   1. Core resolves FIRST, from the workspace lock, with `--frozen` (#410).
#      Domain dependencies are then installed as a SECOND, SEPARATE layer on top
#      of it. They never join core's resolution, so they can never move it.
#
#   2. That layer is installed under a `--constraint` file exported from the very
#      same lock. Anything a domain pulls that core already resolved is pinned to
#      core's version; a domain that disagrees gets a loud resolution failure
#      instead of quietly replacing a core package in the target directory. This
#      is the supply-chain property the whole design exists for, and it is
#      enforced by the resolver rather than by a convention anyone can forget.
#
# Called from two places, deliberately from one script so they cannot drift:
#
#   sh scripts/sync-domain-deps.sh                      # ci.yml, and locally
#                                                       # after `uv sync`
#   sh ../scripts/sync-domain-deps.sh --target package/ # deploy-app.yml, into
#                                                       # the Lambda package
#
# Any extra arguments are passed through to `uv pip install`, and are resolved
# relative to the CALLER's working directory — this script deliberately does not
# `cd`, because deploy-app.yml runs it from the `api-service` artifact directory
# where `package/` is relative to the caller, not to the repo root.
#
# POSIX sh (CI invokes it as `sh scripts/...`, i.e. dash) — no bashisms.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)

# Through uv, and pinned, for the same reason deploy-app.yml's `compileall` step
# is: the self-hosted runners carry `python3` only, there is no bare `python` on
# PATH, and `--no-project` stops uv walking up and syncing whichever project
# happens to be above the caller's working directory.
run_python() {
  uv run --no-project --python 3.13 python "$@"
}

# Validate before installing anything. An invalid declaration must fail here,
# with a readable message naming the file and line, rather than as an opaque
# resolver error — or worse, as a package that installed fine and shadowed
# something.
run_python "$script_dir/domain_requirements.py" --check

requirement_files=$(run_python "$script_dir/domain_requirements.py" --list)
if [ -z "$requirement_files" ]; then
  echo "No product-domain dependencies declared (ADR-0022); nothing to install."
  exit 0
fi

constraints=$(mktemp)
# shellcheck disable=SC2064 # expand $constraints now, not at trap time
trap "rm -f '$constraints'" EXIT INT TERM

# The WHOLE workspace lock, every package and every group, is the constraint set
# — the same authority `domain_requirements.py` checks direct declarations
# against, so the early check and the resolver agree about what "a core
# dependency" means. `--frozen` reads the lock as it stands and fails rather than
# re-resolving (#410); `--no-hashes` because a constraint file is a version
# authority, not an install manifest, and uv rejects hashes there.
uv export --project "$repo_root" --all-packages --all-groups --frozen \
  --no-emit-workspace --no-hashes --quiet --output-file "$constraints"

# Append each `-r <file>` to the caller's own arguments, which are already the
# positional parameters — so `--target package/` survives and lands ahead of
# them. Domain directories are Python package names, so unquoted word splitting
# over the newline-separated list is safe here.
# shellcheck disable=SC2086
for file in $requirement_files; do
  echo "Product domain dependencies: $file"
  set -- "$@" -r "$file"
done

# One invocation with every domain's file, not one per domain: uv then resolves
# them together and fails on a cross-domain conflict, instead of the last install
# silently winning.
uv pip install "$@" --constraint "$constraints"
