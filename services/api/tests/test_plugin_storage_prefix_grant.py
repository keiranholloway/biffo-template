"""The S3 prefix Core signs URLs for is actually granted in Terraform.

This is the most important test in the object-storage capability, and it exists
because of a defect this estate has already paid for once.

**A presigned URL carries the SIGNER's permissions, and generating one never
contacts S3.** It is a local signing operation. So Core cannot fail fast on a
permission it does not hold: the endpoint returns 200 with a perfectly-formed
payload, and the upload dies in the browser with AccessDenied.

`tabsii-platform/infra/environments/dev/fdd_evidence.tf` records what that cost:
the `agreements/` prefix was missing from the grant, and "0005 M2, M3 and M4 all
went green in CI, deployed cleanly, and left a feature in which no agreement PDF
could be uploaded *or served*". Every unit test stubs the S3 client, so no lane
executed a real PutObject. A human found it by clicking dev.

No amount of Python testing can catch that, because the two halves live in
different languages and neither can see the other. This asserts the one
relationship that spans them: **the prefix the code builds keys under must be
named in the IAM policy that signs for it.**

Modelled on `tabsii-platform`'s `test_evidence_bucket_prefixes.py`, which is the
same guard for the same failure. Deliberately no HCL parser — a substring check
catches the failure mode (a prefix nobody granted) and carries none of the
dependency or brittleness of a real one.

That test also documented its own blind spot, which is worth repeating here: its
scanner's character class had no hyphen, so it could not see
`onboarding-documents/` and never reported it missing. **A guard that cannot see
a prefix is not guarding it** — hence the vacuity assertions below, which fail if
this test is ever pointed at a file it cannot read or a policy it cannot find.
"""

from __future__ import annotations

import re
from pathlib import Path

from api.plugin_storage import KEY_ROOT

# tests → api → services → <repo root>
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TF = _REPO_ROOT / "infra" / "environments" / "dev" / "plugin-storage.core.tf"


def _resource_block() -> str:
    text = _TF.read_text(encoding="utf-8")
    match = re.search(r"Resource\s*=\s*\[(.*?)\]", text, re.DOTALL)
    assert match is not None, f"No Resource list found in {_TF}"
    return match.group(1)


def test_the_terraform_file_is_where_this_test_thinks_it_is() -> None:
    """Guard the guard.

    A moved or renamed file would make every assertion below vacuous by never
    finding a prefix to contradict — the test would pass loudly while checking
    nothing, which is worse than not existing.
    """
    assert _TF.is_file(), f"Expected the plugin-storage Terraform at {_TF}"


def test_the_policy_names_a_resource_list() -> None:
    """Also guarding the guard: an empty match would satisfy any `in` check."""
    assert _resource_block().strip(), "Resource list is empty — nothing is granted"


def test_the_key_root_is_granted() -> None:
    """The prefix `plugin_storage.build_key` writes under must be in the grant.

    Read from the code rather than hard-coded, so renaming `KEY_ROOT` without
    updating Terraform fails here rather than in a browser.
    """
    resources = _resource_block()
    assert f"/{KEY_ROOT}/*" in resources, (
        f"Core signs S3 URLs for keys under {KEY_ROOT!r}/ "
        f"(api.plugin_storage.build_key), but {_TF.name}'s IAM policy does not "
        f"grant that prefix.\n\n"
        f"A presigned URL carries the signer's permissions and presigning never "
        f"contacts S3, so this will not fail here — it returns 200 and the "
        f"browser gets AccessDenied.\n\n"
        f"Granted: {resources.strip()}"
    )


def test_the_grant_carries_both_verbs_the_capability_uses() -> None:
    """PutObject backs the presigned POST; GetObject backs the presigned GET.

    Either missing breaks exactly half the feature, and each half fails only in
    the browser. `head_object` needs no separate action — it is authorised by
    `s3:GetObject`, which is why the policy deliberately does not name it.
    """
    text = _TF.read_text(encoding="utf-8")
    for action in ("s3:PutObject", "s3:GetObject"):
        assert action in text, f"{_TF.name} does not grant {action}"


def test_the_grant_is_not_a_whole_bucket_wildcard() -> None:
    """Scoped to the capability's own prefix, not everything in the bucket.

    The bucket is shared with nothing today, but a grant broader than the code
    can use is a standing invitation for the next feature to quietly rely on it.
    """
    resources = _resource_block()
    assert '_arn}/*"' not in resources.replace(" ", ""), (
        "The policy grants the whole bucket. Scope it to the capability's prefix."
    )
