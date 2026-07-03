import json

import pytest
from pr_signer.permission_edit import apply_permission_change

MANIFEST = json.dumps(
    {
        "name": "notepad",
        "version": "1.0.0",
        "tables": [
            {"name": "notes", "columns": [{"name": "title", "type": "String(200)"}]},
            {
                "name": "tags",
                "permissions": {"list": {"allowed": True, "required_role": []}},
            },
        ],
        "api_routes": [],
    }
)


def _table(result: str, name: str) -> dict:
    return next(t for t in json.loads(result)["tables"] if t["name"] == name)


def test_adds_permission_to_a_table_with_none():
    out = apply_permission_change(
        MANIFEST,
        table="notes",
        operation="create",
        allowed=True,
        required_role=["admin"],
    )
    assert _table(out, "notes")["permissions"]["create"] == {
        "allowed": True,
        "required_role": ["admin"],
    }


def test_updates_an_existing_permission():
    out = apply_permission_change(
        MANIFEST, table="tags", operation="list", allowed=False, required_role=[]
    )
    assert _table(out, "tags")["permissions"]["list"] == {
        "allowed": False,
        "required_role": [],
    }


def test_leaves_other_tables_and_fields_untouched():
    out = apply_permission_change(
        MANIFEST, table="notes", operation="list", allowed=True, required_role=[]
    )
    data = json.loads(out)
    assert data["name"] == "notepad"
    assert _table(out, "notes")["columns"] == [{"name": "title", "type": "String(200)"}]
    # tags' pre-existing permission is preserved
    assert _table(out, "tags")["permissions"]["list"] == {
        "allowed": True,
        "required_role": [],
    }


def test_output_is_valid_json_ending_in_newline():
    out = apply_permission_change(
        MANIFEST, table="notes", operation="read", allowed=True, required_role=[]
    )
    assert out.endswith("\n")
    json.loads(out)  # parses


def test_rejects_unknown_operation():
    with pytest.raises(ValueError, match="unknown operation"):
        apply_permission_change(
            MANIFEST, table="notes", operation="delet", allowed=True, required_role=[]
        )


def test_rejects_undeclared_table():
    with pytest.raises(ValueError, match="not declared"):
        apply_permission_change(
            MANIFEST, table="ghost", operation="list", allowed=True, required_role=[]
        )


def test_rejects_invalid_json():
    with pytest.raises(ValueError, match="not valid JSON"):
        apply_permission_change(
            "{ broken", table="notes", operation="list", allowed=True, required_role=[]
        )


def test_rejects_manifest_without_tables():
    with pytest.raises(ValueError, match="no 'tables'"):
        apply_permission_change(
            json.dumps({"name": "x"}),
            table="notes",
            operation="list",
            allowed=True,
            required_role=[],
        )


# --- prettier-compatible formatting (minimal, CI-clean diffs) ---------------

# A canonically prettier-formatted manifest: short arrays inline, objects broken
# one entry per line, printWidth 100. This is byte-for-byte what `prettier`
# produces (verified against prettier 3), so re-serialization must reproduce it.
CANON = """\
{
  "name": "notepad",
  "version": "1.0.0",
  "tags": ["auth", "notes"],
  "tables": [
    {
      "name": "notes",
      "columns": ["tenant_id", "title"],
      "permissions": {
        "list": {
          "allowed": true,
          "required_role": []
        },
        "create": {
          "allowed": true,
          "required_role": ["admin"]
        }
      }
    }
  ]
}
"""


def test_output_is_prettier_clean_and_minimal_diff():
    # Change only notes.list required_role [] -> ["admin"].
    out = apply_permission_change(
        CANON, table="notes", operation="list", allowed=True, required_role=["admin"]
    )
    # Short arrays stay INLINE (json.dumps(indent=2) would have expanded them).
    assert '"tags": ["auth", "notes"]' in out
    assert '"columns": ["tenant_id", "title"]' in out
    assert '"required_role": ["admin"]' in out  # the changed line, inline
    # The ONLY changed line is notes.list.required_role — everything else byte-identical.
    changed = [
        line
        for line in _diff_lines(CANON, out)
        if (line.startswith("+") or line.startswith("-"))
        and not line.startswith("+++")
        and not line.startswith("---")
    ]
    assert changed == [
        '-          "required_role": []',
        '+          "required_role": ["admin"]',
    ]


def test_idempotent_on_canonical_manifest():
    # Re-applying an already-set permission reproduces the file byte-for-byte,
    # so open_permission_pr correctly detects a no-op (it compares content).
    out = apply_permission_change(
        CANON, table="notes", operation="create", allowed=True, required_role=["admin"]
    )
    assert out == CANON


def test_long_array_wraps_when_it_exceeds_print_width():
    roles = [f"role-number-{n:02d}" for n in range(12)]  # well over 100 cols inline
    out = apply_permission_change(
        CANON, table="notes", operation="update", allowed=True, required_role=roles
    )
    # Wrapped one-per-line, not inline.
    assert '"required_role": [\n            "role-number-00",' in out
    assert json.loads(out)  # still valid JSON
    perms = _table(out, "notes")["permissions"]
    assert perms["update"]["required_role"] == roles


def _diff_lines(before: str, after: str) -> list[str]:
    import difflib

    return list(
        difflib.unified_diff(before.splitlines(), after.splitlines(), lineterm="", n=0)
    )
