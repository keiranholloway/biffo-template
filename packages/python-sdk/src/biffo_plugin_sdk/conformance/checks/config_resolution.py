"""#1523 seam 4 — config resolution end-to-end.

**Not yet implemented.** The plan this milestone (#1924) executes
(`docs/implementation/0007-plugin-verify-conformance/README.md`) scoped this
seam out because, when it was written, #1517 had not landed a `config:` block
on `PluginManifest` at all. **That has since changed: #1517 is closed, and
`PluginManifest.config` (`biffo_plugin_sdk.plugin.ConfigDeclaration`) exists
today.** Recorded here rather than left silently stale — the blocker this
module's history names is gone, but implementing the check itself (declared
needs resolved from a local file/fake SSM; missing `required` fails install;
the three cache states exercised) is real, separately-scoped work this
milestone's read-set (`cli/src/lib/plugin-verify/`, this `conformance/`
package) was not asked to do, and #1924's own done-when fixes the count this
PR must leave at `1 implemented, 4 not-implemented`. A follow-up milestone
should turn this into a real check now that its gate has cleared, rather than
this module quietly growing one outside its own scope.

This module exists — with no `run` — so `--list-checks` names this seam
rather than letting the denominator silently shrink.
"""

from __future__ import annotations

CHECK_NAME = "config_resolution"
IMPLEMENTED = False
NOTE = (
    "#1517 (PluginManifest.config) has landed; the check itself is unimplemented, out of M2's scope"
)
