"""Inert placeholder — see `_skeletons/sibling-template`'s copy for the real guard.

biffo-template#1330. `shared-files.json`'s `filesFromSkeleton` parity check
(`cli/src/lib/shared-files-parity.test.ts`) requires every entry to exist in
every skeleton the marker table can select, so a missing copy can never be a
silent empty-copy hazard — the same reasoning already applied to
`.prettierrc`/`.prettierignore` for #1343, where a plugin repo carries an
inert copy of a file it has no functional use for.

This guard has no meaning for a plugin repo. The real file asserts that every
literal `/api/v1/...` call a sibling app's frontend makes resolves to a route
that app's own BFF (`services/api`) registers, reading both halves from
`api.main.app` and `apps/frontend/src/**` — a plugin repo has neither of
those trees: it mounts into a host application rather than owning a
frontend-to-BFF seam of its own.

Deliberately NOT the real file's content. The real guard imports `fastapi`
and `starlette` and does `from api.main import app`; none of those are a
dependency or a module this skeleton ships, so a verbatim copy would fail
`pyright` (which walks the whole tree, `[tool.pyright]` in `pyproject.toml`
carries no exclude for this path) on every plugin repo scaffolded from it.
`pytest` is not at risk either way — `[tool.pytest.ini_options]`'s
`testpaths = ["tests"]` already excludes this directory from collection — but
`pyright` and `ruff check .` are not scoped the same way, so this stub has to
be syntactically inert on its own: no imports, no names, nothing to check.
"""
