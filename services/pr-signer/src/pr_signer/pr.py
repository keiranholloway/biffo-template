"""Open a permission-change PR (ADR-0008), given an injected GitHub client.

This is the PR-signer's orchestration: locate the plugin manifest, apply the
one permission change (``permission_edit``), and open a pull request attributing
the requesting admin. The GitHub client is a Protocol so this is fully testable
with a fake — the real, App-authenticated implementation (Contents API + short-
lived installation token) is a later phase.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any, Protocol

from .permission_edit import apply_permission_change


@dataclass(frozen=True)
class PermissionChangeRequest:
    """A validated request to change one plugin table/operation permission.

    v1 is plugin-only (ADR-0008): ``plugin`` names the manifest at
    ``services/<plugin>/biffo.plugin.json``.
    """

    plugin: str
    table: str
    operation: str
    allowed: bool
    required_role: list[str]


@dataclass(frozen=True)
class GitFile:
    path: str
    content: str
    sha: str


class GitHubContents(Protocol):
    """The minimal GitHub surface the signer needs. The real implementation
    authenticates as a GitHub App with a short-lived, single-repo token."""

    def get_file(self, path: str, ref: str) -> GitFile: ...

    def create_branch(self, branch: str, from_ref: str) -> None: ...

    def put_file(
        self, *, path: str, content: str, message: str, branch: str, sha: str
    ) -> None: ...

    def open_pull_request(
        self, *, head: str, base: str, title: str, body: str
    ) -> str: ...


@dataclass(frozen=True)
class PrResult:
    url: str
    branch: str
    audit: dict[str, Any]


def manifest_path(plugin: str) -> str:
    return f"services/{plugin}/biffo.plugin.json"


def _branch_name(req: PermissionChangeRequest, content: str) -> str:
    # Deterministic + unique per resulting content, so the same change reuses a
    # name and different changes don't collide.
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()[:8]
    return f"biffo/endpoint-{req.plugin}-{req.table}-{req.operation}-{digest}"


def _rule_summary(req: PermissionChangeRequest) -> str:
    roles = ", ".join(req.required_role) if req.required_role else "any authenticated"
    state = "enabled" if req.allowed else "disabled"
    return f"{state} (roles: {roles})"


def _commit_message(req: PermissionChangeRequest, requester: str) -> str:
    return (
        f"feat(permissions): {req.operation} on {req.plugin}/{req.table} -> "
        f"{_rule_summary(req)}\n\nRequested by {requester} via the portal endpoints view (ADR-0008)."
    )


def _pr_title(req: PermissionChangeRequest) -> str:
    return f"Set {req.operation} permission on {req.plugin}/{req.table}"


def _pr_body(req: PermissionChangeRequest, requester: str) -> str:
    return "\n".join(
        [
            f"**Requested by `{requester}`** via the portal endpoints view (ADR-0008).",
            "",
            f"Sets `{req.operation}` on plugin `{req.plugin}`, table `{req.table}` to "
            f"**{_rule_summary(req)}**.",
            "",
            "This only edits the plugin's `permissions` block. Review and merge to deploy the "
            "change through the normal pipeline — nothing is live until then.",
        ]
    )


def _audit(
    req: PermissionChangeRequest, requester: str, branch: str, url: str
) -> dict[str, Any]:
    return {
        "event": "endpoint_permission_change_pr",
        "requester": requester,
        "plugin": req.plugin,
        "table": req.table,
        "operation": req.operation,
        "allowed": req.allowed,
        "required_role": list(req.required_role),
        "branch": branch,
        "pr_url": url,
    }


def open_permission_pr(
    gh: GitHubContents,
    req: PermissionChangeRequest,
    *,
    requester: str,
    base: str = "main",
) -> PrResult:
    """Apply the permission change to the plugin manifest and open a PR.

    Reads the manifest at ``base``, applies the change, and (if it actually
    changed anything) creates a branch, commits the new file, and opens a PR
    attributing ``requester``. Raises ``ValueError`` if the change is a no-op
    (the permission is already set that way) or if the edit is invalid.
    """
    path = manifest_path(req.plugin)
    current = gh.get_file(path, base)
    new_content = apply_permission_change(
        current.content,
        table=req.table,
        operation=req.operation,
        allowed=req.allowed,
        required_role=req.required_role,
    )
    if new_content == current.content:
        raise ValueError(
            f"{req.plugin}/{req.table}.{req.operation} is already set to {_rule_summary(req)}"
        )

    branch = _branch_name(req, new_content)
    gh.create_branch(branch, base)
    gh.put_file(
        path=path,
        content=new_content,
        message=_commit_message(req, requester),
        branch=branch,
        sha=current.sha,
    )
    url = gh.open_pull_request(
        head=branch,
        base=base,
        title=_pr_title(req),
        body=_pr_body(req, requester),
    )
    return PrResult(url=url, branch=branch, audit=_audit(req, requester, branch, url))
