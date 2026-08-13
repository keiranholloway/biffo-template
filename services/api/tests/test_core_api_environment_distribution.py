"""The Core API env vars the template owns are supplied by a file it can ship.

This is the guard for biffo-template#1538 and #1540, and — like
`test_plugin_storage_prefix_grant.py` next door — it exists because the estate
has already paid for the failure.

## The failure

`module "core_api"` is declared in `infra/environments/dev/main.tf`, which
`core-manifest.json` lists as **user-owned**, and its `environment_variables` is
a literal map inside that block. Terraform has no mechanism for a second file to
add an argument to a module block another file declares: arguments are not
additive across files, and `_override.tf` replaces an argument rather than
merging into it.

So a template-owned change could not carry a new environment variable into an
instance's Core API. Not "did not" — **could not**, and nothing said so. Two
casualties, both live:

* `BIFFO_PLUGIN_MEDIA_BUCKET` (#1538). `plugin-storage.core.tf` distributes the
  IAM grant, so every instance's Core role *can* sign for `plugins/*` — and the
  bucket **name** only ever existed on a hand-written line in the template's own
  `main.tf`. Confirmed absent from the live `tabsii-platform-dev-core-api`
  Lambda's configuration, so `api.plugin_storage._bucket()` raises and plugin
  object storage has never worked in any instance, anywhere. The half that
  distributed is what made the half that did not invisible: the grant is
  present, so nothing looks missing.
* `BIFFO_PR_SIGNER_FUNCTION_NAME` (#1540). Same file, same block, same
  non-distribution.

## What this asserts, and why in this shape

The fix gives `core_api` the mechanism `module "plugin_host"` already has: the
module block consumes a `merge()` whose first argument is declared in the
**template-owned** `infra/environments/dev/core-api-environment.core.tf`. This
file asserts the two relationships that span Python and HCL, which neither
language's own tests can see:

1. every environment variable name Core's `Settings` resolves for these two
   capabilities is **supplied by that template-owned file** — read from the
   `Settings` field rather than hard-coded, so renaming a field without updating
   Terraform fails here rather than on a deployed Lambda; and
2. the merge puts the **caller-supplied map first**, so instance config can
   never silently shadow a core key.

Deliberately no HCL parser, for the same reason the prefix-grant guard next door
gives: a regex catches the failure mode (a key nobody supplies) and carries none
of the dependency or brittleness of a real one. The vacuity assertions below are
the price of that choice — a guard that cannot see its subject is not guarding
it.

## What it deliberately does NOT assert

`main.tf`'s own adoption line. `main.tf` is user-owned, so a template-owned test
demanding content in it would red every instance's CI on a file the instance
must change itself — the exact #325/#327/#1452 class, and
`cli/src/lib/python-test-scope-scan.ts` would (correctly) refuse this file for
it. The template's own adoption is guarded in
`cli/src/lib/core-api-environment-adoption.test.ts`, which skips itself in an
instance repo for that reason.

That split is not tidiness: **merging the change that adds this file does not,
by itself, fix #1538 or #1540 in any instance.** Until an instance edits its own
`main.tf`, the variable and local ship and are simply never read.
"""

from __future__ import annotations

import re
from pathlib import Path

from api.config import Settings

# tests → api → services → <repo root>
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TF = _REPO_ROOT / "infra" / "environments" / "dev" / "core-api-environment.core.tf"

# The Settings fields whose values ONLY Terraform can supply, because each is
# computed from another Terraform resource — which is precisely why neither can
# live in a variable's `default` (Terraform requires that to be a constant) and
# why the local exists at all. Named by FIELD, not by env var: the env var name
# is derived below from the field plus `Settings`' own `env_prefix`, so this
# list cannot drift from the code the way a second copy of the names would.
_TEMPLATE_OWNED_SETTINGS_FIELDS = (
    "plugin_media_bucket",  # ADR-0021 object storage, #1538
    "pr_signer_function_name",  # ADR-0008 endpoint control plane, #1540
)

_MERGE_RE = re.compile(
    r"core_api_environment\s*=\s*merge\(\s*(?P<first>[A-Za-z0-9_.]+)\s*,\s*\{"
    r"(?P<body>.*?)\n\s*\}\)",
    re.DOTALL,
)


def _env_var_name(field: str) -> str:
    """The environment variable `Settings` reads for `field`.

    Derived from the model rather than restated, so a renamed field or a changed
    `env_prefix` fails here instead of silently unsetting a deployed Lambda.
    """
    assert field in Settings.model_fields, (
        f"api.config.Settings has no field {field!r}. If it was renamed, rename "
        f"it in {_TF.name} too — the Lambda reads the env var, not the field."
    )
    prefix = Settings.model_config.get("env_prefix", "")
    return f"{prefix}{field}".upper()


def _merge_block() -> tuple[str, str]:
    """The (first merge argument, literal map body) of `local.core_api_environment`."""
    match = _MERGE_RE.search(_TF.read_text(encoding="utf-8"))
    assert match is not None, (
        f"No `core_api_environment = merge(<map>, {{ ... }})` found in {_TF}. "
        f"That merge IS the distribution channel — without it the template has "
        f"no way to put an environment variable on module.core_api at all."
    )
    return match.group("first"), match.group("body")


def test_the_terraform_file_is_where_this_test_thinks_it_is() -> None:
    """Guard the guard.

    A moved or renamed file makes every assertion below vacuous by never finding
    a key to contradict — the test would pass loudly while checking nothing.
    This is the assertion that actually failed across the estate in #1452, when
    a `.core.tf` file was added but never declared template-owned, so it never
    arrived.
    """
    assert _TF.is_file(), f"Expected the Core API environment carve-out at {_TF}"


def test_the_merge_body_is_not_empty() -> None:
    """Also guarding the guard: an empty body would satisfy any `in` check."""
    _, body = _merge_block()
    assert body.strip(), (
        f"{_TF.name}'s core_api_environment merge supplies nothing — the channel "
        f"exists but carries no keys."
    )


def test_the_caller_supplied_map_is_merged_first() -> None:
    """Instance config must never silently shadow a core key.

    The rule, and its wording, come from `plugin-host.core.tf`, which set it:

        # `plugin_host_environment` first so a core key can never be silently
        # overridden by instance config — a plugin shadowing BIFFO_CORE_API_URL
        # would break every plugin on the host, not just its own.

    Here the same ordering stops an instance pointing Core's object storage at a
    bucket `plugin-storage.core.tf`'s IAM grant does not cover — which would
    produce presigned URLs that are perfectly well-formed and AccessDenied in
    the browser.
    """
    first, _ = _merge_block()
    assert first == "var.core_api_environment", (
        f"{_TF.name} merges {first!r} first. The caller-supplied map must be the "
        f"FIRST argument and the template's core keys second, so a later "
        f"argument (the core keys) wins. Reversing this lets any instance "
        f"silently override a core key."
    )


def test_the_variable_is_declared_in_the_same_template_owned_file() -> None:
    """The variable must ship with the merge that reads it.

    Declaring it in the user-owned `variables.tf` instead would reintroduce the
    whole defect one level down: the merge would distribute and the declaration
    it depends on would not, and `terraform validate` would fail in every
    instance rather than in the repo that made the change.
    """
    text = _TF.read_text(encoding="utf-8")
    assert re.search(r'variable\s+"core_api_environment"\s*\{', text), (
        f"{_TF.name} reads var.core_api_environment but does not declare "
        f'variable "core_api_environment" — an instance would fail to plan.'
    )
    assert re.search(r"type\s*=\s*map\(string\)", text), (
        f"{_TF.name}'s core_api_environment must be typed map(string)."
    )
    assert re.search(r"default\s*=\s*\{\s*\}", text), (
        f"{_TF.name}'s core_api_environment needs an empty default, or every "
        f"instance must set it before it can plan at all."
    )


def test_every_template_owned_setting_is_supplied_by_the_carve_out() -> None:
    """The keys the template owns must come from the file the template can ship.

    This is the whole of #1538/#1540 in one assertion. A key present only in the
    user-owned `main.tf` reaches exactly one repo: this one.
    """
    _, body = _merge_block()
    for field in _TEMPLATE_OWNED_SETTINGS_FIELDS:
        name = _env_var_name(field)
        assert re.search(rf"^\s*{re.escape(name)}\s*=", body, re.MULTILINE), (
            f"api.config.Settings reads {name} (field {field!r}), but "
            f"{_TF.name} does not supply it.\n\n"
            f"Setting it in infra/environments/dev/main.tf instead does NOT "
            f"work: that file is user-owned, `biffo core upgrade` never carries "
            f"it, and Terraform cannot add an argument to a module block from "
            f"another file. The variable is simply absent on every instance's "
            f"Lambda — which is how plugin object storage shipped broken "
            f"everywhere (#1538)."
        )


def test_each_supplied_value_is_computed_from_terraform_state() -> None:
    """A hard-coded value here would be a different bug wearing this fix's hat.

    Every key in this map is here *because* its value comes from another
    Terraform resource — that is exactly what a variable `default` cannot hold,
    and therefore the reason the local exists rather than a bare variable. A
    literal string would satisfy the assertion above while quietly meaning the
    key never needed this mechanism, or worse, that someone pinned a bucket name.
    """
    _, body = _merge_block()
    for field in _TEMPLATE_OWNED_SETTINGS_FIELDS:
        name = _env_var_name(field)
        match = re.search(rf"^\s*{re.escape(name)}\s*=(?P<value>.*)$", body, re.MULTILINE)
        assert match is not None, f"{name} is not assigned in {_TF.name}"
        value = match.group("value")
        assert "module." in value, (
            f"{name} in {_TF.name} is set to {value.strip()!r}, which references "
            f"no Terraform resource. If a constant is genuinely right, it belongs "
            f"in var.core_api_environment's default, not here."
        )
