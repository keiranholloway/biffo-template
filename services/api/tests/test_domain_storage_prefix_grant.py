"""Guard: `domains/*` is granted to the Core API role only, and no wider."""

from __future__ import annotations

import re
from pathlib import Path

from api.domain_storage import KEY_ROOT

_DEV = Path(__file__).resolve().parents[3] / "infra" / "environments" / "dev"
_TF = _DEV / "domain-storage.core.tf"
_BLOCK_RE = re.compile(
    r'resource\s+"aws_iam_role_policy"\s+"(?P<name>\w+)"\s*\{(?P<body>.*?)\n\}', re.DOTALL
)


def _blocks(path: Path) -> list[tuple[str, str]]:
    return [(m["name"], m["body"]) for m in _BLOCK_RE.finditer(path.read_text(encoding="utf-8"))]


def _resources(body: str) -> list[str]:
    match = re.search(r"Resource\s*=\s*\[(.*?)\]", body, re.DOTALL)
    if match is None:
        return []
    return re.findall(r'"([^"]+)"', match.group(1))


def _role(body: str) -> str:
    match = re.search(r"role\s*=\s*(\S+)", body)
    assert match is not None
    return match.group(1)


def test_file_and_policy_exist() -> None:
    assert _TF.is_file()
    assert _blocks(_TF), "no aws_iam_role_policy found; guard would be vacuous"


def test_core_api_role_is_granted_exactly_domains_prefix() -> None:
    blocks = _blocks(_TF)
    for name, body in blocks:
        assert _role(body) == "module.core_api.role_name", f"{name} is not the Core API role"
        resources = _resources(body)
        assert resources, name
        for res in resources:
            assert res.endswith(f"/{KEY_ROOT}/*"), f"{name} grants {res}, wider than domains/*"
        for action in ("s3:PutObject", "s3:GetObject", "s3:DeleteObject"):
            assert action in body, f"{name} lacks {action}"


def test_no_policy_in_the_environment_grants_domains_to_the_plugin_host() -> None:
    seen = 0
    for tf in sorted(_DEV.glob("*.tf")):
        for name, body in _blocks(tf):
            seen += 1
            if any(f"/{KEY_ROOT}/" in r or r.endswith(f"/{KEY_ROOT}*") for r in _resources(body)):
                assert _role(body) == "module.core_api.role_name", (
                    f"{tf.name}:{name} grants {KEY_ROOT}/* to {_role(body)}"
                )
    assert seen >= 3


def test_plugin_storage_file_does_not_name_domains() -> None:
    text = (_DEV / "plugin-storage.core.tf").read_text(encoding="utf-8")
    assert f"/{KEY_ROOT}/" not in re.sub(r"(?m)^\s*#.*$", "", text)


def test_only_the_domain_storage_file_names_the_prefix() -> None:
    """Catches grants hidden in data documents or other files (e.g. plugin host)."""
    for tf in sorted(_DEV.glob("*.tf")):
        if tf == _TF:
            continue
        text = re.sub(r"(?m)^\s*#.*$", "", tf.read_text(encoding="utf-8"))
        assert f"/{KEY_ROOT}/" not in text, f"{tf.name} names the {KEY_ROOT}/ prefix"
