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

## Two roles, not one

`api.plugin_storage` (where `KEY_ROOT` and `build_key` live) is importable from
anywhere Core's code is importable — and a plugin's `admin_ingress` app runs on
the SHARED PLUGIN HOST (ADR-0021), a different Lambda with its own IAM role, not
on Core. The two roles are never assumed together, so Core holding the
`plugins/*` grant proves nothing about whether the host does. Checking only
`core_api_plugin_media` and stopping there would have missed exactly that gap —
which is how the host went without this grant for as long as it did. So this
file walks every `aws_iam_role_policy` resource in the Terraform file, not just
the first one, and requires each to carry the prefix independently.
"""

from __future__ import annotations

import re
from pathlib import Path

from api.plugin_storage import KEY_ROOT

# tests → api → services → <repo root>
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TF = _REPO_ROOT / "infra" / "environments" / "dev" / "plugin-storage.core.tf"

# Matches each top-level `resource "aws_iam_role_policy" "<name>" { ... }`
# block. The closing brace is anchored at the start of a line (no leading
# whitespace) because every nested brace in these blocks (jsonencode({...}))
# is indented — a real HCL parser would not need this, but the file's own
# convention makes it a safe substring boundary, in keeping with this test's
# deliberate choice not to depend on one.
_POLICY_BLOCK_RE = re.compile(
    r'resource\s+"aws_iam_role_policy"\s+"(?P<name>\w+)"\s*\{(?P<body>.*?)\n\}',
    re.DOTALL,
)


def _policy_blocks() -> list[tuple[str, str]]:
    """Every (resource name, block body) pair in the Terraform file."""
    text = _TF.read_text(encoding="utf-8")
    return [(m.group("name"), m.group("body")) for m in _POLICY_BLOCK_RE.finditer(text)]


def _resource_list(body: str, *, block_name: str) -> str:
    match = re.search(r"Resource\s*=\s*\[(.*?)\]", body, re.DOTALL)
    assert match is not None, f"No Resource list found in {block_name!r} in {_TF}"
    return match.group(1)


def test_the_terraform_file_is_where_this_test_thinks_it_is() -> None:
    """Guard the guard.

    A moved or renamed file would make every assertion below vacuous by never
    finding a prefix to contradict — the test would pass loudly while checking
    nothing, which is worse than not existing.
    """
    assert _TF.is_file(), f"Expected the plugin-storage Terraform at {_TF}"


def test_the_file_grants_more_than_one_role() -> None:
    """Also guarding the guard, for the two-role gap specifically.

    A file that grants only Core would satisfy every other assertion below
    while leaving the plugin host — a different Lambda, a different role —
    ungranted. This asserts the class of gap this test exists to catch is
    still visible to it, not just the specific `plugins/*` prefix.
    """
    blocks = _policy_blocks()
    assert len(blocks) >= 2, (
        f"Expected at least two aws_iam_role_policy blocks in {_TF.name} "
        f"(Core's role and the shared plugin host's role — ADR-0021), found "
        f"{len(blocks)}: {[name for name, _ in blocks]}. A plugin's "
        f"admin_ingress app runs on the host, not on Core, so a grant to only "
        f"one role leaves the other's presigned URLs signing for nothing."
    )


def test_the_policy_names_a_resource_list() -> None:
    """Also guarding the guard: an empty match would satisfy any `in` check."""
    for name, body in _policy_blocks():
        assert _resource_list(body, block_name=name).strip(), (
            f"{name}'s Resource list is empty — nothing is granted"
        )


def test_the_key_root_is_granted_to_every_role() -> None:
    """The prefix `plugin_storage.build_key` writes under must be in EVERY grant.

    Read from the code rather than hard-coded, so renaming `KEY_ROOT` without
    updating Terraform fails here rather than in a browser. Checked against
    every `aws_iam_role_policy` block in the file, not just the first: Core and
    the shared plugin host are different Lambdas with different roles, and a
    presigned URL only works if the role that SIGNED it holds the grant.
    """
    blocks = _policy_blocks()
    for name, body in blocks:
        resources = _resource_list(body, block_name=name)
        assert f"/{KEY_ROOT}/*" in resources, (
            f"Core signs S3 URLs for keys under {KEY_ROOT!r}/ "
            f"(api.plugin_storage.build_key), but {_TF.name}'s {name!r} IAM "
            f"policy does not grant that prefix.\n\n"
            f"A presigned URL carries the SIGNING role's permissions and "
            f"presigning never contacts S3, so this will not fail here — it "
            f"returns 200 and the browser gets AccessDenied.\n\n"
            f"Granted by {name!r}: {resources.strip()}"
        )


def test_the_grant_carries_both_verbs_the_capability_uses() -> None:
    """PutObject backs the presigned POST; GetObject backs the presigned GET.

    Either missing breaks exactly half the feature, and each half fails only in
    the browser. `head_object` needs no separate action — it is authorised by
    `s3:GetObject`, which is why the policy deliberately does not name it.
    Checked per role: one role carrying both verbs says nothing about whether
    the other does.
    """
    for name, body in _policy_blocks():
        for action in ("s3:PutObject", "s3:GetObject"):
            assert action in body, f"{_TF.name}'s {name!r} policy does not grant {action}"


def test_the_grant_is_not_a_whole_bucket_wildcard() -> None:
    """Scoped to the capability's own prefix, not everything in the bucket.

    The bucket is shared with nothing today, but a grant broader than the code
    can use is a standing invitation for the next feature to quietly rely on
    it. Checked per role, so a future third grant can't hide a bucket wildcard
    behind an earlier, correctly-scoped one.
    """
    for name, body in _policy_blocks():
        resources = _resource_list(body, block_name=name)
        assert '_arn}/*"' not in resources.replace(" ", ""), (
            f"{name!r} grants the whole bucket. Scope it to the capability's prefix."
        )
