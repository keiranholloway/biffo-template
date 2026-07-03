# Guide: Exposing CRUD Endpoints (Generic CRUD Layer)

The Core API can serve list/read/create/update/delete for a table **without you writing any route handlers** — you declare which operations are allowed, and the API synthesizes the endpoints. This is for the common case: a table whose HTTP surface is ordinary CRUD, scoped to the caller's tenant.

You turn an endpoint on with a small **declaration in a file, then a deploy** — there is no runtime toggle and no admin screen. It's config-as-code, reviewed in a PR and baked into the deployment. (For _why_ it works this way, see [ADR-0004](../ADR/0004-generic-crud-layer-and-table-permissions.md).)

## Two ways to expose a table

| Your table is…                                                  | Declare it in…                                            | Served at                         |
| --------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------- |
| a **core** table (a `TenantScopedModel` in the Core API)        | `__crud_permissions__` on the model class                 | `/api/v1/data/<table>`            |
| a **plugin** table (declared in a plugin's `biffo.plugin.json`) | the table's `permissions` block (+ an `api_routes` entry) | `/api/v1/plugins/<plugin>/<path>` |

Both share the same permission model below. `User` (`/users`, `/auth/me`) deliberately does **not** use this — those routes stay hand-written.

## The permission block

Every operation is described by a rule:

```json
{ "allowed": false, "required_role": [] }
```

- **`allowed`** — `false` (the default) means the operation doesn't exist; `true` exposes it. This is **default-deny**: a table with no permissions, or an operation left out, is invisible.
- **`required_role`** — an **any-of** list matched against the caller's roles (their Cognito groups, via the `cognito:groups` claim). `[]` means any authenticated caller. `["admin"]` means the caller must be in the `admin` group.

The five operations are `list`, `read`, `create`, `update`, `delete`. A typo (e.g. `delet`, or `role` instead of `required_role`) is a hard validation error at deploy time, not a silent denial.

## Path A — a core table → `/api/v1/data/<table>`

Add a `__crud_permissions__` class variable to the model (in `services/api/src/api/models/`). The table must already exist (model + a migration); an existing table just needs this one addition.

```python
from typing import Any, ClassVar
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column
from api.models.base import TenantScopedModel


class Widget(TenantScopedModel):
    __tablename__ = "widgets"
    name: Mapped[str] = mapped_column(String(200))

    __crud_permissions__: ClassVar[dict[str, Any]] = {
        "list":   {"allowed": True,  "required_role": []},        # any logged-in user
        "read":   {"allowed": True,  "required_role": []},
        "create": {"allowed": True,  "required_role": ["admin"]}, # admins only
        "update": {"allowed": True,  "required_role": ["admin"]},
        # delete omitted -> not exposed
    }
```

That mounts:

| Method & path                   | Operation | Who                      |
| ------------------------------- | --------- | ------------------------ |
| `GET /api/v1/data/widgets`      | list      | any authenticated caller |
| `GET /api/v1/data/widgets/{id}` | read      | any authenticated caller |
| `POST /api/v1/data/widgets`     | create    | `admin` only             |
| `PUT /api/v1/data/widgets/{id}` | update    | `admin` only             |

`delete` is left out, so `DELETE …/widgets/{id}` isn't mounted at all. Only `allowed: true` operations become routes.

## Path B — a plugin table → `/api/v1/plugins/<plugin>/<path>`

In the plugin's `services/<plugin>/biffo.plugin.json`, declare the route in `api_routes` **and** allow it in the table's `permissions`:

```json
{
  "tables": [
    {
      "name": "widgets",
      "columns": [{ "name": "name", "type": "String(200)" }],
      "permissions": {
        "list": { "allowed": true, "required_role": [] },
        "create": { "allowed": true, "required_role": ["admin"] }
      }
    }
  ],
  "api_routes": [
    { "method": "GET", "path": "/widgets", "table": "widgets", "operation": "list" },
    { "method": "POST", "path": "/widgets", "table": "widgets", "operation": "create" }
  ]
}
```

For plugins the route must appear in **both** places: `api_routes` says the route exists, and `permissions` says who may use it. A route declared in `api_routes` but not allowed in `permissions` returns 404 — fail-closed.

## How requests behave

- **Not exposed → `404`.** A table/operation that isn't allowed is indistinguishable from one that doesn't exist. (This is deliberate — it doesn't leak which tables exist.)
- **Exposed but wrong role → `403`.** The operation exists; the caller just isn't in a `required_role` group.
- **Tenant scoping is automatic.** Every query is filtered by the caller's `tenant_id`, and `tenant_id`/`id`/`created_at`/`updated_at` are never settable from a request body. You don't configure this — it always applies.

Request/response shapes:

- `list` → `200`, a JSON array of rows.
- `read` → `200` with the row, or `404` if no such row in your tenant.
- `create` → `201` with the created row (send a JSON object of the settable columns; unknown keys are ignored).
- `update` → `200` with the updated row.
- `delete` → `200`, `{ "deleted": true, "id": "..." }`.

## Turning it on (the deploy)

The declaration only takes effect once it's deployed:

```bash
git add -A && git commit -m "feat(api): expose CRUD for widgets"
git push            # or open a PR and merge
biffo deploy <environment> --app-only   # if you deploy manually
```

At deploy, the `biffo:db-init` step builds the **permissions registry** from every bundled manifest and every core model's `__crud_permissions__`, in strict mode — so a malformed permission block **fails the deploy loudly** rather than silently disappearing. Once the deploy is green, the endpoints are live.

There is no live/runtime switch: changing a permission is a code change that ships through your normal deploy, the same as any other. Roles come from the caller's `cognito:groups`, so grant a user access by putting them in the right Cognito group — no redeploy needed for that part.

## Quick checklist

1. Table exists (core model + migration, or plugin manifest `tables`).
2. Add the `permissions` (plugin) or `__crud_permissions__` (core) block, with `allowed: true` on the operations you want.
3. Set `required_role` (empty = any authenticated caller; a group name = that group only).
4. For plugins, add the matching `api_routes` entries.
5. Commit → deploy. Check the endpoint (authenticated) returns `200`, and that a non-member gets `403` on a role-gated write.
