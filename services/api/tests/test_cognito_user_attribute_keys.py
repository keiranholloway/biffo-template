"""`aws_cognito_user` attribute keys must be declared UNPREFIXED (#1476).

The AWS provider's read and write paths disagree about the `custom:` prefix, so
declaring a custom attribute the obvious way — with the prefix, matching what
AWS actually stores — makes Terraform delete the attribute it has just written,
on every other apply, forever.

## The mechanism, from `hashicorp/aws` v5.100.0

`internal/service/cognitoidp/user.go`:

- **Read strips the prefix.** `flattenAttributeTypes` does
  `TrimPrefix(TrimPrefix(k, "dev:"), "custom:")` before `d.Set("attributes", …)`,
  so AWS's `custom:tenant_id` is stored in state as plain `tenant_id`.
- **The diff is a plain key comparison.** `expandUpdateUserAttributes(old, new)`
  walks the config map, removes each matched key from the state map, and returns
  everything *left in state* as the delete list.
- **The delete list is re-prefixed on the way out.**
  `AdminDeleteUserAttributes` is called with
  `ApplyToAll(del, normalizeUserAttributeKey)`.

So with `"custom:tenant_id"` in config: state holds `tenant_id`, config holds
`custom:tenant_id`, the two never match, and the key lands in BOTH the update
and the delete list. The provider writes `custom:tenant_id`, then deletes
`custom:tenant_id` a second later.

It alternates rather than deleting every time because the next apply finds the
attribute absent — state is empty, so there is nothing left over to delete, and
the attribute is restored. Then the cycle repeats.

## Why unprefixed is correct rather than a workaround

`expandAttributeTypes` normalises on write (`normalizeUserAttributeKey` adds
`custom:` to any non-standard key), so an unprefixed `tenant_id` still reaches
AWS as `custom:tenant_id`. Both sides then agree on `tenant_id` and the diff is
genuinely empty. Nothing about the deployed pool changes.

## Why this is a test rather than a comment

Terraform is not exercised by any test in this repo — the pool exists only at
apply time — so a regression here is invisible until someone reads CloudTrail.
It went unnoticed for six weeks precisely because the symptom is silent: nothing
reads the claim today (`middleware/auth.py` hardcodes `tenant_id="default"`),
so the attribute vanishing changes no behaviour. That stops being true the
moment ADR-0001's multi-tenant seam is activated, at which point an
authorization input would be intermittently absent.

Measured before the fix: 23 deletions in biffo-platform and 50+ (API cap) in
tabsii-platform, all `['custom:tenant_id']`.

## What this does NOT cover

Terraform treats the `attributes` map as the FULL desired state, so any
attribute set on the seeded admin out of band — a `given_name` from the portal,
say — is deleted on the next apply. That is documented provider behaviour, not
this defect, and this guard deliberately does not assert against it. Conflating
the two was a wrong call recorded and corrected on #1476.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_AUTH_MODULE = _REPO_ROOT / "modules/cloud/aws/auth/main.tf"

#: Prefixes the provider adds back itself. A key carrying one of these in the
#: config is the defect: it cannot ever match what `flattenAttributeTypes` puts
#: into state, because that function strips exactly these.
_PROVIDER_MANAGED_PREFIXES = ("custom:", "dev:")


@pytest.fixture(scope="module")
def auth_tf() -> str:
    return _AUTH_MODULE.read_text()


def _cognito_user_attribute_keys(auth_tf: str) -> list[str]:
    """The keys of the `attributes = { … }` map inside `aws_cognito_user`.

    Scoped to that resource rather than the whole file: `aws_cognito_user_pool`
    has its own `schema` blocks that legitimately name `tenant_id`, and a
    file-wide scan would either miss the resource entirely or fail on the pool's
    unrelated declarations.
    """
    resource = re.search(
        r'resource\s+"aws_cognito_user"\s+"\w+"\s*\{(.*?)\n\}',
        auth_tf,
        re.DOTALL,
    )
    assert resource, "aws_cognito_user resource not found — has the module been restructured?"

    block = re.search(r"attributes\s*=\s*\{(.*?)\n  \}", resource.group(1), re.DOTALL)
    assert block, "aws_cognito_user has no attributes map"

    keys = []
    for line in block.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r'^"?([^"\s=]+)"?\s*=', line)
        if match:
            keys.append(match.group(1))
    return keys


class TestAttributeKeysRoundTrip:
    def test_the_attributes_map_is_found_and_non_empty(self, auth_tf: str) -> None:
        # Guards the parser itself: every assertion below passes vacuously over
        # an empty list, which is the shape of check this estate keeps finding.
        assert _cognito_user_attribute_keys(auth_tf)

    def test_no_attribute_key_carries_a_provider_managed_prefix(self, auth_tf: str) -> None:
        offenders = [
            key
            for key in _cognito_user_attribute_keys(auth_tf)
            if key.startswith(_PROVIDER_MANAGED_PREFIXES)
        ]

        assert not offenders, (
            f"aws_cognito_user attribute key(s) {offenders} carry a prefix the AWS "
            f"provider adds itself. The provider STRIPS these when reading into "
            f"state and RE-ADDS them when writing, so a prefixed key in config can "
            f"never match state: every apply will write the attribute and delete "
            f"it one second later, alternating forever. Declare it unprefixed "
            f"(e.g. `tenant_id`, not `custom:tenant_id`) — it still reaches AWS "
            f"prefixed. See #1476 and this module's docstring."
        )

    def test_the_tenant_id_seam_is_still_declared(self, auth_tf: str) -> None:
        # The fix is "drop the prefix", NOT "drop the attribute". ADR-0001's
        # multi-tenant seam is the reason it exists, so a future edit that
        # deletes it outright should fail here rather than pass quietly.
        assert "tenant_id" in _cognito_user_attribute_keys(auth_tf)
