import json

import pytest
from pr_signer.pr import (
    GitFile,
    PermissionChangeRequest,
    manifest_path,
    open_permission_pr,
)

MANIFEST = json.dumps(
    {
        "name": "notepad",
        "version": "1.0.0",
        "tables": [{"name": "notes", "columns": [{"name": "title", "type": "String(200)"}]}],
        "api_routes": [],
    }
)


class FakeGitHub:
    """Records the calls the signer makes and returns a canned file."""

    def __init__(self, file_content: str):
        self._content = file_content
        self.created_branch: tuple[str, str] | None = None
        self.put: dict | None = None
        self.pr: dict | None = None

    def get_file(self, path: str, ref: str) -> GitFile:
        self.get = (path, ref)
        return GitFile(path=path, content=self._content, sha="deadbeef")

    def create_branch(self, branch: str, from_ref: str) -> None:
        self.created_branch = (branch, from_ref)

    def put_file(self, *, path: str, content: str, message: str, branch: str, sha: str) -> None:
        self.put = {
            "path": path,
            "content": content,
            "message": message,
            "branch": branch,
            "sha": sha,
        }

    def open_pull_request(self, *, head: str, base: str, title: str, body: str) -> str:
        self.pr = {"head": head, "base": base, "title": title, "body": body}
        return "https://github.com/acme/instance/pull/42"


def _req(**over) -> PermissionChangeRequest:
    base = {
        "plugin": "notepad",
        "table": "notes",
        "operation": "create",
        "allowed": True,
        "required_role": ["admin"],
    }
    base.update(over)
    return PermissionChangeRequest(**base)


def test_opens_a_pr_with_the_patched_manifest():
    gh = FakeGitHub(MANIFEST)
    result = open_permission_pr(gh, _req(), requester="alice@example.com", base="dev")

    # read the right file at the base branch
    assert gh.get == (manifest_path("notepad"), "dev")
    # branch created from base, and the file committed to it against the read sha
    assert gh.created_branch is not None and gh.created_branch[1] == "dev"
    assert gh.put is not None and gh.put["branch"] == result.branch and gh.put["sha"] == "deadbeef"
    # the committed content actually carries the change
    committed = json.loads(gh.put["content"])
    notes = next(t for t in committed["tables"] if t["name"] == "notes")
    assert notes["permissions"]["create"] == {
        "allowed": True,
        "required_role": ["admin"],
    }
    # PR opened head->base, returns the URL
    assert gh.pr is not None and gh.pr["base"] == "dev" and gh.pr["head"] == result.branch
    assert result.url == "https://github.com/acme/instance/pull/42"


def test_pr_and_commit_attribute_the_requester():
    gh = FakeGitHub(MANIFEST)
    open_permission_pr(gh, _req(), requester="alice@example.com", base="dev")
    assert gh.pr is not None and gh.put is not None
    assert "alice@example.com" in gh.pr["body"]
    assert "alice@example.com" in gh.put["message"]


def test_audit_captures_the_change():
    gh = FakeGitHub(MANIFEST)
    result = open_permission_pr(gh, _req(allowed=True, required_role=["admin"]), requester="bob")
    assert result.audit == {
        "event": "endpoint_permission_change_pr",
        "requester": "bob",
        "plugin": "notepad",
        "table": "notes",
        "operation": "create",
        "allowed": True,
        "required_role": ["admin"],
        "branch": result.branch,
        "pr_url": result.url,
    }


def test_noop_change_raises_and_opens_no_pr():
    # First apply the change, then request the identical change against the result.
    gh = FakeGitHub(MANIFEST)
    open_permission_pr(gh, _req(), requester="a", base="dev")
    assert gh.put is not None
    already = FakeGitHub(gh.put["content"])
    with pytest.raises(ValueError, match="already set"):
        open_permission_pr(already, _req(), requester="a", base="dev")
    assert already.pr is None  # no PR opened for a no-op


def test_same_change_is_deterministic_different_change_differs():
    b1 = open_permission_pr(FakeGitHub(MANIFEST), _req(), requester="a").branch
    b2 = open_permission_pr(FakeGitHub(MANIFEST), _req(), requester="a").branch
    b3 = open_permission_pr(FakeGitHub(MANIFEST), _req(required_role=[]), requester="a").branch
    assert b1 == b2  # same resulting content -> same branch
    assert b1 != b3  # different content -> different branch
