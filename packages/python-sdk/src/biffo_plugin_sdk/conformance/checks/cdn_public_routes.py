"""#1523 seam 5 — manifest-declared public routes asserted against the CDN
path contract.

**Not yet implemented, and deliberately not scheduled.** The plan this
milestone implements (`docs/implementation/0007-plugin-verify-conformance/
README.md`) found this seam splits in two during research: the CDN path
contract *document* (public path -> rewritten origin path -> origin -> token
requirement) is M4 (biffo-template#1923), a template-owned Terraform/CLI
change with no dependency on a plugin repo. The *other* half — this harness
asserting a manifest-declared route against that contract — needs
`RouteDef` (`biffo_plugin_sdk.plugin`) to gain a public/unauthenticated flag
it does not have today; every declared route is synthesised CRUD behind the
gate, and the `/c/<token>` tracked-link path is hard-wired in Terraform, not
manifest-declared. That schema change belongs with Phase 0's manifest work,
not this harness, so it is recorded as a named gap rather than filed as a
milestone (see the plan's "Blocked items", third entry).

This module exists — with no `run` — so `--list-checks` names this seam
rather than letting the denominator silently shrink (biffo-template#1924's own
done-when: `1 implemented, 4 not-implemented`).
"""

from __future__ import annotations

CHECK_NAME = "cdn_public_routes"
IMPLEMENTED = False
NOTE = "needs a public/unauthenticated flag on RouteDef -- named gap on M4 / #1923, not yet planned"
