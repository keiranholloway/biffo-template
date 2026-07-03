"""Tests for the App-authenticated GitHub client (ADR-0008 Phase 2).

No network: an ``httpx.MockTransport`` stands in for the GitHub REST API and
records every request. A throwaway RSA key (generated per test module) lets us
mint and verify real App JWTs, so the auth flow is exercised end to end without
a real GitHub App.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from pr_signer.github_app import GitHubApiError, GitHubAppContents
from pr_signer.pr import PermissionChangeRequest, open_permission_pr

APP_ID = "123456"
INSTALLATION_ID = "42"
OWNER = "acme"
REPO = "widget"

PLUGIN_MANIFEST = json.dumps(
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


@pytest.fixture(scope="module")
def keypair() -> tuple[str, object]:
    """A throwaway RSA keypair: PEM private key + public key object."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    return pem, key.public_key()


def _iso(offset_seconds: float, *, base: float = 1_000_000.0) -> str:
    return (
        (
            datetime.fromtimestamp(base, tz=timezone.utc)
            + timedelta(seconds=offset_seconds)
        )
        .isoformat()
        .replace("+00:00", "Z")
    )


class FakeGitHub:
    """Records requests and returns canned GitHub REST responses."""

    def __init__(
        self,
        *,
        manifest: str = PLUGIN_MANIFEST,
        sha: str = "filesha",
        token_expiry_iso: str = _iso(3600),
        pull_status: int = 201,
    ) -> None:
        self.manifest = manifest
        self.sha = sha
        self.token_expiry_iso = token_expiry_iso
        self.pull_status = pull_status
        self.calls: list[dict] = []
        self.jwts_presented: list[str] = []
        self.tokens_issued = 0
        self.created_refs: list[dict] = []
        self.puts: list[dict] = []
        self.pulls: list[dict] = []

    def client(self, *, private_key: str, clock) -> GitHubAppContents:
        transport = httpx.MockTransport(self._handle)
        return GitHubAppContents(
            client=httpx.Client(base_url="https://api.github.com", transport=transport),
            app_id=APP_ID,
            private_key=private_key,
            installation_id=INSTALLATION_ID,
            owner=OWNER,
            repo=REPO,
            clock=clock,
        )

    def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        auth = request.headers.get("Authorization", "")
        body = json.loads(request.content) if request.content else None
        self.calls.append(
            {"method": request.method, "path": path, "auth": auth, "body": body}
        )

        if path.endswith("/access_tokens") and request.method == "POST":
            self.jwts_presented.append(auth.removeprefix("Bearer "))
            self.tokens_issued += 1
            return httpx.Response(
                201,
                json={
                    "token": f"ghs_token{self.tokens_issued}",
                    "expires_at": self.token_expiry_iso,
                },
            )

        if "/contents/" in path and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "content": base64.b64encode(self.manifest.encode()).decode(),
                    "sha": self.sha,
                },
            )

        if "/git/ref/heads/" in path and request.method == "GET":
            return httpx.Response(200, json={"object": {"sha": "basecommitsha"}})

        if path.endswith("/git/refs") and request.method == "POST":
            assert body is not None
            self.created_refs.append(body)
            return httpx.Response(201, json={"ref": body["ref"]})

        if "/contents/" in path and request.method == "PUT":
            assert body is not None
            self.puts.append(body)
            return httpx.Response(200, json={"commit": {"sha": "newcommitsha"}})

        if path.endswith("/pulls") and request.method == "POST":
            assert body is not None
            self.pulls.append(body)
            if self.pull_status >= 400:
                return httpx.Response(
                    self.pull_status, json={"message": "Validation Failed"}
                )
            return httpx.Response(
                self.pull_status,
                json={"html_url": "https://github.com/acme/widget/pull/7"},
            )

        return httpx.Response(404, json={"message": "Not Found"})


@pytest.fixture
def private_key(keypair: tuple[str, object]) -> str:
    return keypair[0]


class _Clock:
    """A callable, mutable clock so tests can advance time deterministically."""

    def __init__(self, t: float = 1_000_000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def test_get_file_decodes_content_and_sha(private_key):
    fake = FakeGitHub()
    gh = fake.client(private_key=private_key, clock=_Clock())

    result = gh.get_file("services/notes/biffo.plugin.json", "main")

    assert result.content == PLUGIN_MANIFEST
    assert result.sha == "filesha"
    # ref is passed through as a query param.
    get = next(c for c in fake.calls if "/contents/" in c["path"])
    assert "services/notes/biffo.plugin.json" in get["path"]


def test_installation_token_is_minted_and_reused(private_key):
    fake = FakeGitHub()
    gh = fake.client(private_key=private_key, clock=_Clock())

    gh.get_file("a/b.json", "main")
    gh.get_file("a/b.json", "main")

    # Token exchanged once, then cached across both reads.
    assert fake.tokens_issued == 1
    # Repo calls carry the installation token, not the App JWT.
    repo_calls = [c for c in fake.calls if "/contents/" in c["path"]]
    assert all(c["auth"] == "Bearer ghs_token1" for c in repo_calls)


def test_token_refreshes_after_expiry(private_key):
    fake = FakeGitHub(token_expiry_iso=_iso(120))  # expires 120s after base
    clock = _Clock(1_000_000.0)
    gh = fake.client(private_key=private_key, clock=clock)

    gh.get_file("a/b.json", "main")  # mints token1 (valid until base+120)
    clock.t = 1_000_000.0 + 200  # advance past expiry
    gh.get_file("a/b.json", "main")  # must mint token2

    assert fake.tokens_issued == 2


def test_app_jwt_is_signed_and_scoped(private_key, keypair):
    fake = FakeGitHub()
    gh = fake.client(private_key=private_key, clock=_Clock())

    gh.get_file("a/b.json", "main")

    assert len(fake.jwts_presented) == 1
    # The JWT is minted against the fake clock, so it looks "expired" to
    # wall-clock validation — verify the signature and claims, not liveness.
    decoded = jwt.decode(
        fake.jwts_presented[0],
        keypair[1],
        algorithms=["RS256"],
        options={"verify_exp": False},
    )
    assert decoded["iss"] == APP_ID
    assert decoded["exp"] > decoded["iat"]


def test_create_branch_reads_base_ref_then_posts_new_ref(private_key):
    fake = FakeGitHub()
    gh = fake.client(private_key=private_key, clock=_Clock())

    gh.create_branch("biffo/endpoint-x", "main")

    assert fake.created_refs == [
        {"ref": "refs/heads/biffo/endpoint-x", "sha": "basecommitsha"}
    ]


def test_put_file_sends_base64_content_and_sha(private_key):
    fake = FakeGitHub()
    gh = fake.client(private_key=private_key, clock=_Clock())

    gh.put_file(
        path="services/notes/biffo.plugin.json",
        content="new-content\n",
        message="msg",
        branch="biffo/x",
        sha="filesha",
    )

    assert len(fake.puts) == 1
    put = fake.puts[0]
    assert base64.b64decode(put["content"]).decode() == "new-content\n"
    assert put["sha"] == "filesha"
    assert put["branch"] == "biffo/x"


def test_open_pull_request_returns_html_url(private_key):
    fake = FakeGitHub()
    gh = fake.client(private_key=private_key, clock=_Clock())

    url = gh.open_pull_request(head="biffo/x", base="main", title="t", body="b")

    assert url == "https://github.com/acme/widget/pull/7"
    assert fake.pulls == [
        {"head": "biffo/x", "base": "main", "title": "t", "body": "b"}
    ]


def test_non_success_raises_github_api_error(private_key):
    fake = FakeGitHub(pull_status=422)
    gh = fake.client(private_key=private_key, clock=_Clock())

    with pytest.raises(GitHubApiError) as exc:
        gh.open_pull_request(head="h", base="main", title="t", body="b")

    assert exc.value.status == 422
    # The error message must not carry the token/auth header.
    assert "ghs_token" not in str(exc.value)
    assert "Bearer" not in str(exc.value)


def test_end_to_end_open_permission_pr_against_fake_github(private_key):
    fake = FakeGitHub()
    gh = fake.client(private_key=private_key, clock=_Clock())
    req = PermissionChangeRequest(
        plugin="notes",
        table="note",
        operation="create",
        allowed=True,
        required_role=["admin"],
    )

    result = open_permission_pr(gh, req, requester="alice@example.com")

    assert result.url == "https://github.com/acme/widget/pull/7"
    # A branch was created, the manifest was committed, and a PR opened.
    assert len(fake.created_refs) == 1
    assert len(fake.puts) == 1
    assert len(fake.pulls) == 1
    committed = json.loads(base64.b64decode(fake.puts[0]["content"]).decode())
    note = next(t for t in committed["tables"] if t["name"] == "note")
    assert note["permissions"]["create"] == {
        "allowed": True,
        "required_role": ["admin"],
    }
