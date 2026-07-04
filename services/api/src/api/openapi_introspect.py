"""Turn a FastAPI/OpenAPI schema into display-friendly endpoint "specifics".

Pure functions over the dict returned by ``app.openapi()`` — no FastAPI app or
request needed — so they're trivially unit-testable. Used by the admin
"Endpoints" view to (a) list every mounted route and (b) render one route's
request/response shapes as flat field tables plus a synthesized example (the
swagger-ish detail panel).

Kept generic and reusable: it knows nothing about which routes exist, only how to
read OpenAPI. New endpoints show up automatically with their schemas.
"""

from __future__ import annotations

from typing import Any

from .schemas.endpoint import (
    BodySpec,
    EndpointDetail,
    EndpointResponse,
    ParamSpec,
    ResponseSpec,
    SchemaField,
)

_JSON = "application/json"
_HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options"}
# Methods we surface in the listing/detail (skip head/options — plumbing).
_SHOWN_METHODS = {"get", "post", "put", "patch", "delete"}


def _ref_name(node: Any) -> str | None:
    if isinstance(node, dict) and isinstance(node.get("$ref"), str):
        return node["$ref"].rsplit("/", 1)[-1]
    return None


def _deref(node: Any, components: dict[str, Any]) -> Any:
    """Follow a single ``$ref`` to its target schema (one hop)."""
    name = _ref_name(node)
    if name is None:
        return node
    return components.get(name, {})


def _type_label(node: Any, components: dict[str, Any]) -> str:
    """A short human type label for a JSON-schema node."""
    name = _ref_name(node)
    if name is not None:
        # Reference to a named model — label as the model name.
        return name
    if not isinstance(node, dict):
        return "any"
    for combiner in ("anyOf", "oneOf", "allOf"):
        if combiner in node:
            parts = [_type_label(s, components) for s in node[combiner]]
            # Dedupe, preserve order (collapses the common `X | null` optional).
            return " | ".join(dict.fromkeys(parts))
    if "enum" in node:
        return "enum"
    node_type = node.get("type")
    if node_type == "array":
        return f"array<{_type_label(node.get('items', {}), components)}>"
    if isinstance(node_type, list):
        return " | ".join(node_type)
    return node_type or "object"


def _notes(node: Any, components: dict[str, Any]) -> str | None:
    """Summarise enum/format/constraints into one line."""
    node = _deref(node, components)
    if not isinstance(node, dict):
        return None
    bits: list[str] = []
    if "enum" in node:
        bits.append("one of: " + ", ".join(str(v) for v in node["enum"]))
    if node.get("format"):
        bits.append(f"format: {node['format']}")
    for key, label in (
        ("minLength", "min length"),
        ("maxLength", "max length"),
        ("minimum", "min"),
        ("maximum", "max"),
        ("pattern", "pattern"),
    ):
        if key in node:
            bits.append(f"{label} {node[key]}")
    return "; ".join(bits) or None


def _fields(node: Any, components: dict[str, Any]) -> list[SchemaField]:
    """Flatten an object schema's top-level properties into display fields."""
    node = _deref(node, components)
    if not isinstance(node, dict):
        return []
    props = node.get("properties")
    if not isinstance(props, dict):
        return []
    required = set(node.get("required", []))
    out: list[SchemaField] = []
    for name, prop in props.items():
        resolved = _deref(prop, components)
        description = (
            resolved.get("description") if isinstance(resolved, dict) else None
        )
        out.append(
            SchemaField(
                name=name,
                type=_type_label(prop, components),
                required=name in required,
                description=description,
                notes=_notes(prop, components),
            )
        )
    return out


def _example(node: Any, components: dict[str, Any], seen: frozenset[str]) -> Any:
    """Synthesize a minimal example value for a JSON-schema node.

    Prefers explicit ``example``/``default``/first-``enum``; otherwise placeholder
    by type. Guards against recursive models via ``seen`` (ref names on the stack).
    """
    ref = _ref_name(node)
    if ref is not None:
        if ref in seen:
            return {}
        seen = seen | {ref}
        node = components.get(ref, {})
    if not isinstance(node, dict):
        return None
    if "example" in node:
        return node["example"]
    if "default" in node:
        return node["default"]
    if node.get("enum"):
        return node["enum"][0]
    for combiner in ("anyOf", "oneOf"):
        if combiner in node:
            options = node[combiner]
            non_null = [
                s for s in options if _deref(s, components).get("type") != "null"
            ]
            chosen = non_null[0] if non_null else (options[0] if options else None)
            return _example(chosen, components, seen) if chosen is not None else None
    if "allOf" in node and node["allOf"]:
        merged: dict[str, Any] = {}
        for part in node["allOf"]:
            value = _example(part, components, seen)
            if isinstance(value, dict):
                merged.update(value)
        return merged
    node_type = node.get("type")
    if node_type == "object" or "properties" in node:
        return {
            name: _example(prop, components, seen)
            for name, prop in node.get("properties", {}).items()
        }
    if node_type == "array":
        return [_example(node.get("items", {}), components, seen)]
    placeholder: dict[str, Any] = {
        "string": "string",
        "integer": 0,
        "number": 0,
        "boolean": False,
        "null": None,
    }
    return placeholder.get(node_type) if isinstance(node_type, str) else None


def _json_media(content: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Pick the JSON media type from an OpenAPI content map, else the first one."""
    if not isinstance(content, dict) or not content:
        return None
    if _JSON in content:
        return _JSON, content[_JSON]
    ctype, media = next(iter(content.items()))
    return ctype, media


def _parameters(
    operation: dict[str, Any], components: dict[str, Any]
) -> list[ParamSpec]:
    out: list[ParamSpec] = []
    for param in operation.get("parameters", []):
        if not isinstance(param, dict):
            continue
        out.append(
            ParamSpec(
                name=param.get("name", ""),
                location=param.get("in", ""),
                type=_type_label(param.get("schema", {}), components),
                required=bool(param.get("required", False)),
                description=param.get("description"),
            )
        )
    return out


def _operation(
    openapi: dict[str, Any], method: str, path: str
) -> dict[str, Any] | None:
    item = openapi.get("paths", {}).get(path)
    if not isinstance(item, dict):
        return None
    op = item.get(method.lower())
    return op if isinstance(op, dict) else None


def build_endpoint_detail(
    openapi: dict[str, Any], method: str, path: str
) -> EndpointDetail | None:
    """Resolve one route's specifics from the OpenAPI schema, or None if absent."""
    operation = _operation(openapi, method, path)
    if operation is None:
        return None
    components = openapi.get("components", {}).get("schemas", {})

    request_body: BodySpec | None = None
    body = operation.get("requestBody")
    if isinstance(body, dict):
        picked = _json_media(body.get("content", {}))
        if picked is not None:
            content_type, media = picked
            schema = media.get("schema", {})
            request_body = BodySpec(
                content_type=content_type,
                fields=_fields(schema, components),
                example=media.get("example")
                or _example(schema, components, frozenset()),
            )

    responses: list[ResponseSpec] = []
    for code, resp in sorted(operation.get("responses", {}).items()):
        if not isinstance(resp, dict):
            continue
        fields: list[SchemaField] = []
        example: Any | None = None
        content_type: str | None = None
        picked = _json_media(resp.get("content", {}))
        if picked is not None:
            content_type, media = picked
            schema = media.get("schema", {})
            fields = _fields(schema, components)
            example = media.get("example") or _example(schema, components, frozenset())
        responses.append(
            ResponseSpec(
                status_code=str(code),
                description=resp.get("description"),
                content_type=content_type,
                fields=fields,
                example=example,
            )
        )

    return EndpointDetail(
        method=method.upper(),
        path=path,
        summary=operation.get("summary"),
        description=operation.get("description"),
        parameters=_parameters(operation, components),
        request_body=request_body,
        responses=responses,
    )


def collect_openapi_endpoints(
    openapi: dict[str, Any],
    crud_endpoints: list[EndpointResponse],
) -> list[EndpointResponse]:
    """Every mounted route from OpenAPI, sorted by path then method, enriched with
    generic-CRUD permission metadata where a route matches one (by method+path)."""
    by_key = {(e.method, e.path): e for e in crud_endpoints}
    out: list[EndpointResponse] = []
    for path, item in openapi.get("paths", {}).items():
        if not isinstance(item, dict):
            continue
        for method, operation in item.items():
            if method.lower() not in _SHOWN_METHODS or not isinstance(operation, dict):
                continue
            upper = method.upper()
            summary = operation.get("summary")
            tags = list(operation.get("tags", []))
            crud = by_key.get((upper, path))
            if crud is not None:
                out.append(
                    EndpointResponse(
                        source=crud.source,
                        plugin=crud.plugin,
                        table=crud.table,
                        operation=crud.operation,
                        method=upper,
                        path=path,
                        summary=summary,
                        tags=tags,
                        required_role=crud.required_role,
                        permission_editable=(crud.source == "plugin"),
                    )
                )
            else:
                out.append(
                    EndpointResponse(
                        source="bespoke",
                        method=upper,
                        path=path,
                        summary=summary,
                        tags=tags,
                        required_role=None,
                        permission_editable=False,
                    )
                )
    out.sort(key=lambda e: (e.path, e.method))
    return out
