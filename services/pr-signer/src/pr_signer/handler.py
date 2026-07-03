"""Lambda entrypoint for the isolated PR-signer (ADR-0008 Phase 2).

The Core API is the only caller: it authenticates and authorizes the admin,
validates the request, then invokes this function **directly over IAM**
(RequestResponse). This function has no public endpoint. Its job is the one
privileged act the Core API deliberately cannot do — hold the GitHub App
credential and open the permission-change PR:

    invoke event ──► parse/validate ──► read App key from Secrets Manager ──►
    GitHubAppContents ──► open_permission_pr ──► { pr_url, branch, audit }

The invoke event is a flat JSON object (what the Core API sends):

    {
      "requester": "admin@example.com",   # who asked (for attribution/audit)
      "plugin": "notes",                  # services/<plugin>/biffo.plugin.json
      "table": "note",
      "operation": "create",              # a CRUD op (create/read/update/delete/list)
      "allowed": true,
      "required_role": ["admin"]          # optional; defaults to []
    }

The response is always a dict with a ``statusCode``; the App private key and the
installation token are **never** returned or logged. The audit record (who,
what, resulting branch + PR) is emitted as a structured log on success.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol

from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.typing import LambdaContext

from .github_app import GitHubApiError, GitHubAppContents
from .pr import GitHubContents, PermissionChangeRequest, open_permission_pr

logger = Logger()


class SecretReader(Protocol):
    """Reads a secret's string value by id. Injected so the handler core is
    testable without boto3 or a real Secrets Manager."""

    def get_secret(self, secret_id: str) -> str: ...


class SecretsManagerReader:
    """Default :class:`SecretReader`, backed by AWS Secrets Manager.

    boto3 is imported lazily (the Lambda runtime provides it) and the value is
    cached across warm invocations so we hit Secrets Manager at most once per
    container. The secret value is never logged.
    """

    def __init__(self) -> None:
        self._client: Any = None
        self._cache: dict[str, str] = {}

    def get_secret(self, secret_id: str) -> str:
        if secret_id in self._cache:
            return self._cache[secret_id]
        if self._client is None:
            import boto3

            self._client = boto3.client("secretsmanager")
        response = self._client.get_secret_value(SecretId=secret_id)
        value = response["SecretString"]
        self._cache[secret_id] = value
        return value


@dataclass(frozen=True)
class SignerConfig:
    """Static configuration for the signer, read from the Lambda's environment.

    The App private key is **not** here — it is read from Secrets Manager by id
    at invoke time, so the long-lived secret never sits in an env var.
    """

    app_id: str
    installation_id: str
    owner: str
    repo: str
    private_key_secret_id: str
    base_branch: str = "main"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> SignerConfig:
        source = os.environ if env is None else env

        def required(key: str) -> str:
            value = source.get(key)
            if not value:
                raise ValueError(f"missing required environment variable {key}")
            return value

        return cls(
            app_id=required("BIFFO_PR_SIGNER_APP_ID"),
            installation_id=required("BIFFO_PR_SIGNER_INSTALLATION_ID"),
            owner=required("BIFFO_PR_SIGNER_REPO_OWNER"),
            repo=required("BIFFO_PR_SIGNER_REPO_NAME"),
            private_key_secret_id=required("BIFFO_PR_SIGNER_PRIVATE_KEY_SECRET_ID"),
            base_branch=source.get("BIFFO_PR_SIGNER_BASE_BRANCH", "main"),
        )


# A factory that turns the (secret) App private key into a GitHubContents client.
# Injected in tests so no real GitHub client / network is constructed.
ContentsFactory = Callable[[str], GitHubContents]

_CRUD_OPERATIONS = {"create", "read", "update", "delete", "list"}


def parse_request(event: Any) -> tuple[PermissionChangeRequest, str]:
    """Validate the invoke event into a request + requester, or raise ValueError.

    Deliberately strict: the Core API is trusted to have authorized the change,
    but this is the last gate before we write to a repo, so a malformed event is
    rejected rather than coerced.
    """
    if not isinstance(event, Mapping):
        raise ValueError("event must be a JSON object")

    requester = event.get("requester")
    if not isinstance(requester, str) or not requester:
        raise ValueError("event.requester is required")

    def required_str(key: str) -> str:
        value = event.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError(f"event.{key} is required")
        return value

    plugin = required_str("plugin")
    table = required_str("table")
    operation = required_str("operation")
    if operation not in _CRUD_OPERATIONS:
        raise ValueError(
            f"event.operation must be one of {sorted(_CRUD_OPERATIONS)}, got {operation!r}"
        )

    allowed = event.get("allowed")
    if not isinstance(allowed, bool):
        raise ValueError("event.allowed must be a boolean")

    required_role = event.get("required_role", [])
    if not isinstance(required_role, list) or not all(
        isinstance(role, str) for role in required_role
    ):
        raise ValueError("event.required_role must be a list of strings")

    request = PermissionChangeRequest(
        plugin=plugin,
        table=table,
        operation=operation,
        allowed=allowed,
        required_role=list(required_role),
    )
    return request, requester


def _error(status: int, message: str) -> dict[str, Any]:
    return {"statusCode": status, "error": message}


def run(
    event: Any,
    *,
    config: SignerConfig,
    secret_reader: SecretReader,
    contents_factory: ContentsFactory,
) -> dict[str, Any]:
    """Testable handler core: validate, sign, open the PR, and return a result.

    Never raises for expected failures — maps them to ``statusCode``:
    ``400`` (bad event), ``409`` (no-op / invalid edit), ``502`` (GitHub error).
    """
    try:
        request, requester = parse_request(event)
    except ValueError as exc:
        return _error(400, str(exc))

    private_key = secret_reader.get_secret(config.private_key_secret_id)
    gh = contents_factory(private_key)

    try:
        result = open_permission_pr(
            gh, request, requester=requester, base=config.base_branch
        )
    except ValueError as exc:
        # No-op (already set that way) or an invalid edit the manifest rejects.
        return _error(409, str(exc))
    except GitHubApiError as exc:
        return _error(502, str(exc))

    return {
        "statusCode": 200,
        "pr_url": result.url,
        "branch": result.branch,
        "audit": result.audit,
    }


def _build_contents(config: SignerConfig) -> ContentsFactory:
    def factory(private_key: str) -> GitHubContents:
        return GitHubAppContents.for_installation(
            app_id=config.app_id,
            private_key=private_key,
            installation_id=config.installation_id,
            owner=config.owner,
            repo=config.repo,
        )

    return factory


_secret_reader: SecretReader = SecretsManagerReader()


@logger.inject_lambda_context
def handler(event: dict[str, Any], context: LambdaContext) -> dict[str, Any]:
    config = SignerConfig.from_env()
    result = run(
        event,
        config=config,
        secret_reader=_secret_reader,
        contents_factory=_build_contents(config),
    )

    audit = result.get("audit")
    if audit is not None:
        logger.info("endpoint permission PR opened", extra=audit)
    else:
        logger.warning(
            "endpoint permission request rejected",
            extra={"statusCode": result["statusCode"], "error": result.get("error")},
        )
    return result
