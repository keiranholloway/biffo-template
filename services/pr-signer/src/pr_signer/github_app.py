"""App-authenticated GitHub client (ADR-0008 Phase 2).

The real implementation of the ``GitHubContents`` Protocol (``pr.py``). It
authenticates as a **GitHub App** installed on a single repository and mints a
short-lived installation token for each burst of work:

    App private key (RS256) ──► App JWT (10 min) ──► installation access token
    (~1 h, single repo, least-privilege) ──► Contents/Git/Pulls REST calls

Why an App (not a PAT): the credential is scoped to one repository, carries only
the ``contents:write`` + ``pull_requests:write`` permissions the App was granted,
and the token handed to this process expires within the hour. The long-lived
secret (the App private key) lives in Secrets Manager and is only ever used to
sign JWTs — never handed to the data plane.

This module makes **no** authorization decision and holds **no** database access.
It is a mechanical GitHub adapter; the Core API decides *whether* a change may be
requested, and this signer decides only *how* to turn an approved request into a
pull request. The installation token is never logged.
"""

from __future__ import annotations

import base64
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Callable

import httpx
import jwt

from .pr import GitFile

_GITHUB_API = "https://api.github.com"
_ACCEPT = "application/vnd.github+json"
_API_VERSION = "2022-11-28"

# Refresh the installation token this many seconds before it actually expires,
# so a call never races the expiry boundary.
_TOKEN_SKEW_SECONDS = 60


class GitHubApiError(RuntimeError):
    """A GitHub REST call returned a non-success status.

    The message deliberately carries the method, path, and status only — never
    request headers — so an error surfacing in logs cannot leak a token.
    """

    def __init__(self, method: str, path: str, status: int, detail: str) -> None:
        super().__init__(f"GitHub {method} {path} -> {status}: {detail}")
        self.status = status


def _app_jwt(app_id: str, private_key: str, *, now: float) -> str:
    """Mint a GitHub App JWT (RS256), valid ~10 minutes.

    ``iat`` is backdated 60s to tolerate minor clock skew between us and GitHub,
    as GitHub's own docs recommend.
    """
    payload = {
        "iat": int(now) - 60,
        "exp": int(now) + 9 * 60,
        "iss": app_id,
    }
    return jwt.encode(payload, private_key, algorithm="RS256")


def _parse_expiry(expires_at: str) -> float:
    """Parse GitHub's ISO-8601 ``expires_at`` (e.g. ``2026-01-01T00:00:00Z``)."""
    return datetime.fromisoformat(expires_at.replace("Z", "+00:00")).timestamp()


@dataclass
class _CachedToken:
    value: str
    expires_at: float


class GitHubAppContents:
    """``GitHubContents`` implementation backed by a GitHub App installation.

    Construct with :meth:`for_installation` in production (it builds a real
    ``httpx.Client``); tests inject a client wired to an ``httpx.MockTransport``.
    """

    def __init__(
        self,
        *,
        client: httpx.Client,
        app_id: str,
        private_key: str,
        installation_id: str,
        owner: str,
        repo: str,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._client = client
        self._app_id = app_id
        self._private_key = private_key
        self._installation_id = installation_id
        self._owner = owner
        self._repo = repo
        self._clock = clock
        self._token: _CachedToken | None = None

    @classmethod
    def for_installation(
        cls,
        *,
        app_id: str,
        private_key: str,
        installation_id: str,
        owner: str,
        repo: str,
        api_url: str = _GITHUB_API,
        timeout: float = 15.0,
    ) -> GitHubAppContents:
        client = httpx.Client(base_url=api_url, timeout=timeout)
        return cls(
            client=client,
            app_id=app_id,
            private_key=private_key,
            installation_id=installation_id,
            owner=owner,
            repo=repo,
        )

    # -- authentication -----------------------------------------------------

    def _installation_token(self) -> str:
        now = self._clock()
        cached = self._token
        if cached is not None and now < cached.expires_at - _TOKEN_SKEW_SECONDS:
            return cached.value

        app_jwt = _app_jwt(self._app_id, self._private_key, now=now)
        path = f"/app/installations/{self._installation_id}/access_tokens"
        response = self._client.post(
            path,
            headers={
                "Authorization": f"Bearer {app_jwt}",
                "Accept": _ACCEPT,
                "X-GitHub-Api-Version": _API_VERSION,
            },
        )
        self._raise_for_status("POST", path, response)
        data = response.json()
        self._token = _CachedToken(
            value=data["token"],
            expires_at=_parse_expiry(data["expires_at"]),
        )
        return self._token.value

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._installation_token()}",
            "Accept": _ACCEPT,
            "X-GitHub-Api-Version": _API_VERSION,
        }

    def _repo_path(self, suffix: str) -> str:
        return f"/repos/{self._owner}/{self._repo}{suffix}"

    @staticmethod
    def _raise_for_status(method: str, path: str, response: httpx.Response) -> None:
        if response.is_success:
            return
        try:
            detail = response.json().get("message", response.text)
        except (ValueError, AttributeError):
            detail = response.text
        raise GitHubApiError(method, path, response.status_code, str(detail))

    # -- GitHubContents Protocol -------------------------------------------

    def get_file(self, path: str, ref: str) -> GitFile:
        api_path = self._repo_path(f"/contents/{path}")
        response = self._client.get(
            api_path, params={"ref": ref}, headers=self._headers()
        )
        self._raise_for_status("GET", api_path, response)
        data = response.json()
        content = base64.b64decode(data["content"]).decode("utf-8")
        return GitFile(path=path, content=content, sha=data["sha"])

    def create_branch(self, branch: str, from_ref: str) -> None:
        ref_path = self._repo_path(f"/git/ref/heads/{from_ref}")
        ref_response = self._client.get(ref_path, headers=self._headers())
        self._raise_for_status("GET", ref_path, ref_response)
        base_sha = ref_response.json()["object"]["sha"]

        refs_path = self._repo_path("/git/refs")
        create_response = self._client.post(
            refs_path,
            json={"ref": f"refs/heads/{branch}", "sha": base_sha},
            headers=self._headers(),
        )
        self._raise_for_status("POST", refs_path, create_response)

    def put_file(
        self, *, path: str, content: str, message: str, branch: str, sha: str
    ) -> None:
        api_path = self._repo_path(f"/contents/{path}")
        response = self._client.put(
            api_path,
            json={
                "message": message,
                "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
                "branch": branch,
                "sha": sha,
            },
            headers=self._headers(),
        )
        self._raise_for_status("PUT", api_path, response)

    def open_pull_request(self, *, head: str, base: str, title: str, body: str) -> str:
        api_path = self._repo_path("/pulls")
        response = self._client.post(
            api_path,
            json={"head": head, "base": base, "title": title, "body": body},
            headers=self._headers(),
        )
        self._raise_for_status("POST", api_path, response)
        return response.json()["html_url"]
