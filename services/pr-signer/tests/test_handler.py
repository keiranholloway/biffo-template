"""Tests for the PR-signer Lambda handler core (ADR-0008 Phase 2).

Exercises the composition root (``run``) with an injected secret reader and a
Protocol-level fake ``GitHubContents`` — no boto3, no network, no real GitHub
App. Covers the happy path, event validation, config-from-env, and the mapping
of expected failures to ``statusCode``.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from pr_signer.github_app import GitHubApiError
from pr_signer.handler import SignerConfig, parse_request, run
from pr_signer.pr import GitFile

# Canonical form: exactly what apply_permission_change emits (indent=2 + newline),
# so re-applying an already-set permission is a genuine no-op.
MANIFEST = (
    json.dumps(
        {
            "name": "notes",
            "tables": [
                {
                    "name": "note",
                    "permissions": {"read": {"allowed": True, "required_role": []}},
                }
            ],
        },
        indent=2,
    )
    + "\n"
)

CONFIG = SignerConfig(
    app_id="123456",
    installation_id="42",
    owner="acme",
    repo="widget",
    private_key_secret_id="biffo/pr-signer/app-key",
    base_branch="main",
)


class FakeSecretReader:
    def __init__(self, value: str = "-----BEGIN KEY-----fake-----END KEY-----") -> None:
        self.value = value
        self.requested: list[str] = []

    def get_secret(self, secret_id: str) -> str:
        self.requested.append(secret_id)
        return self.value


class FakeContents:
    """Protocol-level fake GitHubContents backed by an in-memory manifest."""

    def __init__(self, *, manifest: str = MANIFEST, fail_pr: bool = False) -> None:
        self._manifest = manifest
        self._fail_pr = fail_pr
        self.private_key_seen: str | None = None
        self.pr_opened: dict[str, Any] | None = None

    def get_file(self, path: str, ref: str) -> GitFile:
        return GitFile(path=path, content=self._manifest, sha="filesha")

    def create_branch(self, branch: str, from_ref: str) -> None:
        pass

    def put_file(
        self, *, path: str, content: str, message: str, branch: str, sha: str
    ) -> None:
        pass

    def open_pull_request(self, *, head: str, base: str, title: str, body: str) -> str:
        if self._fail_pr:
            raise GitHubApiError("POST", "/pulls", 502, "upstream error")
        self.pr_opened = {"head": head, "base": base}
        return "https://github.com/acme/widget/pull/9"


def _event(**over: Any) -> dict[str, Any]:
    base = {
        "requester": "admin@example.com",
        "plugin": "notes",
        "table": "note",
        "operation": "create",
        "allowed": True,
        "required_role": ["admin"],
    }
    base.update(over)
    return base


def _factory(contents: FakeContents):
    def build(private_key: str):
        contents.private_key_seen = private_key
        return contents

    return build


# -- happy path -----------------------------------------------------------


def test_run_opens_pr_and_returns_audit():
    secret = FakeSecretReader()
    contents = FakeContents()

    result = run(
        _event(),
        config=CONFIG,
        secret_reader=secret,
        contents_factory=_factory(contents),
    )

    assert result["statusCode"] == 200
    assert result["pr_url"] == "https://github.com/acme/widget/pull/9"
    assert result["audit"]["requester"] == "admin@example.com"
    assert result["audit"]["operation"] == "create"
    # The key was fetched from the configured secret and handed to the factory.
    assert secret.requested == ["biffo/pr-signer/app-key"]
    assert contents.private_key_seen == secret.value
    # The PR targets the configured base branch.
    assert contents.pr_opened is not None and contents.pr_opened["base"] == "main"


def test_run_respects_configured_base_branch():
    contents = FakeContents()
    config = SignerConfig(
        app_id="1",
        installation_id="2",
        owner="o",
        repo="r",
        private_key_secret_id="s",
        base_branch="dev",
    )

    result = run(
        _event(),
        config=config,
        secret_reader=FakeSecretReader(),
        contents_factory=_factory(contents),
    )

    assert result["statusCode"] == 200
    assert contents.pr_opened is not None and contents.pr_opened["base"] == "dev"


# -- validation -----------------------------------------------------------


@pytest.mark.parametrize(
    "event",
    [
        {"plugin": "notes", "table": "note", "operation": "create", "allowed": True},
        _event(requester=""),
        _event(plugin=""),
        _event(operation="drop"),  # not a CRUD op
        _event(allowed="yes"),  # not a bool
        _event(required_role="admin"),  # not a list
        "not-an-object",
    ],
)
def test_run_rejects_bad_event_with_400(event):
    secret = FakeSecretReader()
    result = run(
        event,
        config=CONFIG,
        secret_reader=secret,
        contents_factory=_factory(FakeContents()),
    )
    assert result["statusCode"] == 400
    assert "audit" not in result
    # A rejected event never reaches the secret or GitHub.
    assert secret.requested == []


def test_parse_request_defaults_required_role_to_empty():
    event = _event()
    del event["required_role"]
    request, requester = parse_request(event)
    assert requester == "admin@example.com"
    assert request.required_role == []


# -- failure mapping ------------------------------------------------------


def test_run_maps_noop_change_to_409():
    # read is already {allowed: true, required_role: []}; requesting the same is a no-op.
    result = run(
        _event(operation="read", allowed=True, required_role=[]),
        config=CONFIG,
        secret_reader=FakeSecretReader(),
        contents_factory=_factory(FakeContents()),
    )
    assert result["statusCode"] == 409
    assert "audit" not in result


def test_run_maps_github_error_to_502():
    result = run(
        _event(),
        config=CONFIG,
        secret_reader=FakeSecretReader(),
        contents_factory=_factory(FakeContents(fail_pr=True)),
    )
    assert result["statusCode"] == 502


# -- config ---------------------------------------------------------------


def test_config_from_env_reads_all_fields():
    env = {
        "BIFFO_PR_SIGNER_APP_ID": "111",
        "BIFFO_PR_SIGNER_INSTALLATION_ID": "222",
        "BIFFO_PR_SIGNER_REPO_OWNER": "acme",
        "BIFFO_PR_SIGNER_REPO_NAME": "widget",
        "BIFFO_PR_SIGNER_PRIVATE_KEY_SECRET_ID": "biffo/pr-signer/app-key",
        "BIFFO_PR_SIGNER_BASE_BRANCH": "dev",
    }
    config = SignerConfig.from_env(env)
    assert config.app_id == "111"
    assert config.installation_id == "222"
    assert config.owner == "acme"
    assert config.repo == "widget"
    assert config.private_key_secret_id == "biffo/pr-signer/app-key"
    assert config.base_branch == "dev"


def test_config_from_env_defaults_base_branch_to_main():
    env = {
        "BIFFO_PR_SIGNER_APP_ID": "1",
        "BIFFO_PR_SIGNER_INSTALLATION_ID": "2",
        "BIFFO_PR_SIGNER_REPO_OWNER": "o",
        "BIFFO_PR_SIGNER_REPO_NAME": "r",
        "BIFFO_PR_SIGNER_PRIVATE_KEY_SECRET_ID": "s",
    }
    assert SignerConfig.from_env(env).base_branch == "main"


def test_config_from_env_raises_on_missing_required():
    with pytest.raises(ValueError, match="BIFFO_PR_SIGNER_APP_ID"):
        SignerConfig.from_env({})
