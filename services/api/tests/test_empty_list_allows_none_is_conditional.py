"""A variable documented as "empty allows none" must actually allow none.

biffo-template#1461: `modules/cloud/aws/storage/main.tf`'s
`aws_s3_bucket_cors_configuration.plugin_media` was created *unconditionally*,
consuming `var.plugin_media_cors_origins` (`type = list(string)`, `default =
[]`) directly as `allowed_origins`. The variable's own description said "Empty
allows none" -- but S3's `PutBucketCors` rejects an empty `AllowedOrigins`
outright, so the true behaviour of an empty list was "fails `terraform apply`",
not "allows none". `terraform validate` cannot see this: an empty list is
perfectly valid HCL for a `list(string)`, and the constraint lives only in the
AWS API, which validate never calls. The defect was invisible in the template's
own CI and unpassable in every instance that took the upgrade without setting
the variable.

The fix makes the resource conditional on a non-empty list, so "empty allows
none" becomes true by construction: no CORS configuration at all *is* what
"allows none" means for a browser's cross-origin request.

This is a class, not an instance. Any Terraform variable whose description
promises "empty allows none" is making the same claim, and the only way that
claim can be true is if every resource consuming it is gated on
`length(var.<name>) > 0` (or equivalent) via `count` or `for_each`. So this
sweeps every `.tf` file under `modules/` for that promise and checks it holds
-- not just the one instance from #1461 -- because the next variable making the
same promise unconditionally is the same bug wearing a different name.
"""

from __future__ import annotations

import re
from pathlib import Path

# tests -> api -> services -> <repo root>
_REPO_ROOT = Path(__file__).resolve().parents[3]
_MODULES_DIR = _REPO_ROOT / "modules"

_VARIABLE_BLOCK_RE = re.compile(
    r'variable\s+"(?P<name>[a-zA-Z0-9_]+)"\s*\{(?P<body>(?:[^{}]|\{[^{}]*\})*)\}',
    re.DOTALL,
)

_RESOURCE_BLOCK_RE = re.compile(
    r'resource\s+"(?P<type>[a-zA-Z0-9_]+)"\s+"(?P<name>[a-zA-Z0-9_]+)"\s*\{'
    r"(?P<body>(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}",
    re.DOTALL,
)


def _all_tf_files() -> list[Path]:
    return sorted(_MODULES_DIR.rglob("*.tf"))


def _module_dirs() -> list[Path]:
    """Every directory under modules/ that directly contains a .tf file.

    A Terraform module's variable declarations and its resources are
    routinely split across sibling files in the same directory (variables.tf,
    main.tf, outputs.tf) -- HCL has no per-file scoping, only per-directory.
    Scanning file-by-file would miss exactly the case in #1461, where
    `plugin_media_cors_origins` is declared in variables.tf and consumed in
    main.tf.
    """
    dirs = {tf.parent for tf in _all_tf_files()}
    return sorted(dirs)


def _empty_allows_none_variables(text: str) -> list[str]:
    """Variable names whose block promises "empty allows none" AND defaults to []."""
    names = []
    for match in _VARIABLE_BLOCK_RE.finditer(text):
        body = match.group("body")
        if "allows none" not in body.lower():
            continue
        if re.search(r"default\s*=\s*\[\s*\]", body) is None:
            continue
        names.append(match.group("name"))
    return names


def test_the_modules_directory_is_where_this_test_thinks_it_is() -> None:
    """Guard the guard.

    A moved or renamed `modules/` directory would make every assertion below
    vacuous by never finding a file to scan -- the test would pass loudly while
    checking nothing, which is worse than not existing.
    """
    assert _MODULES_DIR.is_dir(), f"Expected the Terraform modules dir at {_MODULES_DIR}"
    assert _all_tf_files(), f"Expected at least one .tf file under {_MODULES_DIR}"


def test_the_regressed_variable_is_still_found_by_the_scanner() -> None:
    """Vacuity check for the promise-detector itself.

    If this scanner's pattern stops matching `plugin_media_cors_origins`'s own
    description (rewording, reformatting, a default no longer literally `[]`),
    every assertion below passes by finding nothing to check -- exactly the
    blind spot `test_plugin_storage_prefix_grant.py` already documented for a
    sibling guard in this same file. This pins the scanner against the one
    variable already known to make the promise.
    """
    storage_vars = (_MODULES_DIR / "cloud" / "aws" / "storage" / "variables.tf").read_text(
        encoding="utf-8"
    )
    found = _empty_allows_none_variables(storage_vars)
    assert "plugin_media_cors_origins" in found, (
        "Expected the scanner to find plugin_media_cors_origins as an "
        f"'empty allows none' variable; found {found!r} instead. If the "
        "wording or default changed, update the scanner's pattern rather "
        "than this assertion."
    )


def test_every_empty_allows_none_variable_gates_its_resources_by_length() -> None:
    """The sweep: every "empty allows none" variable must be honoured everywhere.

    For each module directory declaring such a variable (anywhere among its
    .tf files -- HCL scopes per-directory, not per-file), every resource in
    that same directory referencing `var.<name>` must carry `count` or
    `for_each` conditioned on `length(var.<name>) > 0` (or `!= 0` / `== 0 ?
    0 : ...`, any comparison that keys off the list's length). A resource
    that consumes the variable directly, with no such gate, would fail at S3
    apply time exactly as `aws_s3_bucket_cors_configuration.plugin_media` did
    in #1461 -- and would do so invisibly, because `terraform validate`
    cannot catch it either.
    """
    violations: list[str] = []

    for module_dir in _module_dirs():
        promised_vars: set[str] = set()
        module_tf_files = sorted(module_dir.glob("*.tf"))
        for tf_file in module_tf_files:
            promised_vars.update(_empty_allows_none_variables(tf_file.read_text(encoding="utf-8")))

        if not promised_vars:
            continue

        for tf_file in module_tf_files:
            text = tf_file.read_text(encoding="utf-8")

            for resource_match in _RESOURCE_BLOCK_RE.finditer(text):
                body = resource_match.group("body")
                resource_id = f"{resource_match.group('type')}.{resource_match.group('name')}"

                for var_name in promised_vars:
                    var_ref = f"var.{var_name}"
                    if var_ref not in body:
                        continue

                    # The gate must reference this exact variable's length
                    # inside a count/for_each expression, not merely exist
                    # somewhere in the block (which would let an unrelated
                    # count pass this check by accident).
                    gate_re = re.compile(
                        r"(count|for_each)\s*=.*?length\s*\(\s*" + re.escape(var_ref) + r"\s*\)",
                        re.DOTALL,
                    )
                    if gate_re.search(body) is None:
                        violations.append(
                            f"{tf_file.relative_to(_REPO_ROOT)}: resource "
                            f"{resource_id!r} consumes {var_ref!r} (promised "
                            "'empty allows none') without a count/for_each "
                            f"gated on length({var_ref}) -- an empty list "
                            "will reach the AWS API unconditionally, exactly "
                            "as in #1461."
                        )

    assert not violations, "Empty-allows-none promise broken:\n" + "\n".join(violations)
