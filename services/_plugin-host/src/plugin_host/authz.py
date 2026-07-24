"""The real founder authorizer for the shared plugin host (ADR-0011).

Adapts the SDK's ``authorize`` (shared-Cognito JWT verification + group check) to
the host's injectable :data:`~plugin_host.mount.Authorizer` contract, translating
the SDK's auth exceptions into :class:`~plugin_host.mount.GateError` (401/403). The
host — platform code — is the single place that enforces a plugin's declared group;
plugins ship no auth code.
"""

from __future__ import annotations

from typing import Any

from .mount import Authorizer, GateError


def cognito_authorizer(*, config: Any = None, verify: Any = None) -> Authorizer:
    """An :data:`Authorizer` backed by the shared Cognito pool. ``config`` defaults
    to :meth:`CognitoConfig.from_env` (resolved once here); ``verify`` is injectable
    for tests."""
    from biffo_plugin_sdk.user_serving import (
        CognitoConfig,
        ForbiddenError,
        UserAuthError,
        authorize,
    )

    resolved = config or CognitoConfig.from_env()

    def authorize_fn(token: str, required_group: str) -> Any:
        try:
            return authorize(token, required_group=required_group, config=resolved, verify=verify)
        except ForbiddenError as exc:
            raise GateError(403, str(exc)) from exc
        except UserAuthError as exc:  # UnauthorizedError + any config error → 401
            raise GateError(401, str(exc)) from exc

    return authorize_fn
