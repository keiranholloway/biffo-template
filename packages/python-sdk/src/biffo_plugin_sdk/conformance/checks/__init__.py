"""Individual conformance checks, one module per #1523 seam.

Every module here is discovered, not registered — see the parent package's
docstring and `discover_checks()`. A module declares `CHECK_NAME`,
`IMPLEMENTED`, an optional `NOTE`, and — only if implemented — `run(ctx)`.
"""
