"""The header a plugin forwards a founder's token in (ADR-0017 §3/§5).

A plugin's own Lambda calls Core's internal (SigV4) endpoints *on behalf of a
founder*. SigV4 claims the ``Authorization`` header for the AWS signature, so the
founder's Cognito access token rides here instead. Core does not trust the
plugin's word for who that founder is: the token is **re-verified** by Core's own
token→identity mapping, so Core — not the plugin — is the authority on the user's
identity (and the owner of any data the call touches).

**This module is now only the header name.** It used to also own
``require_forwarded_user``, a second dependency that verified the token and
returned — the parallel authorization stack #621 was filed about. It skipped the
``is_active`` deactivation gate (#150) for the whole remaining life (~1h) of a
suspended user's already-issued access token, on every plugin-forwarded route,
because a security fix had landed on one of two copies. #655 made the two copies
share ``authenticated_identity``; #621 step 3 removed the second copy.

Resolution now lives in :mod:`api.middleware.principal` — ``require_principal``
for the caller, ``require_signed_principal`` where a verified service must also
have carried the request. A route that grows a forwarded-token dependency of its
own is reopening the drift, and ``tests/test_one_authorization_model.py`` fails
when one does.
"""

from __future__ import annotations

#: The header the plugin forwards the founder's Cognito access token in. Distinct
#: from ``Authorization`` (which carries the caller's SigV4 signature on these routes).
FORWARDED_USER_HEADER = "X-Biffo-User-Token"
