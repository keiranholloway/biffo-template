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
