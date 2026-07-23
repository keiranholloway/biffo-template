from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BIFFO_", case_sensitive=False)

    # Database — two modes:
    #   Local dev: set database_url directly (localhost default works out of the box).
    #   AWS staging/prod: set db_secret_arn + db_host; credentials fetched from Secrets Manager.
    #   AWS dev (no-NAT): set database_url to the full URL output by Terraform (no outbound call).
    database_url: str = "postgresql+asyncpg://localhost/biffo_dev"
    db_secret_arn: str = ""
    db_host: str = ""

    # Least-privilege application role (#253). The settings above resolve the
    # RDS *master* user — table owner, rds_superuser — which migrations,
    # biffo:db-init and biffo:ddl-import need because they create and alter
    # objects. These resolve the non-owner `biffo_app` role that the HTTP
    # request path connects as instead. Same two modes as above:
    #   AWS staging/prod: app_db_secret_arn (a second Secrets Manager secret).
    #   AWS dev (no-NAT) / local: app_database_url, the full URL.
    # Both unset means no privilege split on this deployment and the request
    # path falls back to the master URL — see database.resolve_app_database_url
    # for why that fallback exists and how it is surfaced.
    app_database_url: str = ""
    app_db_secret_arn: str = ""

    # Postgres search_path applied at connection startup, e.g. "public,acme".
    # Empty by default so the base template is unaffected. Needed only when a
    # deployment maps ADR-0005 DDL-imported tables by bare name in a non-public
    # schema — those are unreachable without it (#458, backported from tabsii).
    db_search_path: str = ""
    # Must match the `username` in the app credential; db-init cross-checks.
    app_role_name: str = "biffo_app"
    # Comma-separated schemas to grant the app role. Empty (the default) grants
    # every non-system schema found at bootstrap time, which is what an
    # ADR-0005 deployment with its own business schema needs. See
    # api.db_app_role's module docstring.
    app_role_schemas: str = ""

    # Cognito
    cognito_user_pool_id: str = ""
    cognito_client_id: str = ""
    cognito_region: str = "us-east-1"
    # Pre-loaded JWKS JSON string — set by Terraform at apply time in no-NAT dev environments
    # so the Lambda can verify JWTs without needing to reach the Cognito JWKS endpoint.
    # If empty, the JWKS is fetched at runtime (requires NAT or cognito-idp VPC endpoint).
    cognito_jwks_json: str = ""

    # EventBridge
    event_bus_name: str = "biffo-events"

    # Plugins (ADR-0003) — directory containing one subdirectory per service,
    # scanned for */biffo.plugin.json. Empty string uses the monorepo's
    # services/ directory (see api.plugins._DEFAULT_SERVICES_ROOT); only
    # meaningful in contexts with a full monorepo checkout — see the
    # api.plugins module docstring for the deployed-Lambda limitation.
    plugin_services_root: str = ""

    # DDL data imports (ADR-0005) — directory containing one subdirectory per
    # import, scanned for */*.sql. Empty string uses the monorepo's
    # db/imports/ directory (see api.ddl_import._DEFAULT_DDL_IMPORT_ROOT);
    # set by Terraform to /var/task/db/imports in the deployed Lambda.
    ddl_import_root: str = ""

    # Endpoint control plane (ADR-0008) — the isolated PR-signer Lambda the Core
    # API invokes to open a permission-change PR. Empty means the control plane
    # isn't provisioned on this deployment (the admin permission endpoint then
    # returns 501). Set by Terraform from the pr_signer module's function name.
    pr_signer_function_name: str = ""

    # Cognito group that authorises admin-only endpoints (ADR-0008 permission
    # changes, and future user management). Membership comes from the verified
    # cognito:groups claim; matches the baseline "admin" group Terraform seeds.
    admin_group: str = "admin"

    # Cognito group conferring platform-admin (ADR-0012). The group on the
    # verified token is the source of truth; `AuthenticatedUser.is_platform_admin`
    # mirrors it. Deployments whose RLS policies read a table rather than the
    # token reconcile that table in their provider's sync_platform_admin. No
    # subject is ever hard-coded — add the platform owners to this group in
    # Cognito and they gain it on their next request, with no code or config
    # change.
    platform_admin_group: str = "platform_admin"

    # Internal service-to-service auth (ADR-0009) — allowlist of IAM principal
    # ARNs permitted on /api/v1/internal/* routes. The SigV4-verified caller's
    # requestContext.authorizer.iam.userArn is matched (fnmatch glob) against
    # this list. Fails closed: empty means no service caller is accepted. Set by
    # Terraform (JSON array) from each authorised plugin's Lambda role ARN, e.g.
    # ["arn:aws:sts::123456789012:assumed-role/acme-dev-plugin-orchestrator-*/*"].
    service_principal_arn_allowlist: list[str] = []

    # Agentic workers (ADR-0014 §8) — the maximum chain depth an agent run may
    # be requested at. Agent runs emit events and events start agent runs, so
    # the cycle is real and every iteration has an LLM invoice attached; the
    # internal create route refuses a request past this depth rather than
    # clamping it. A direct (event → agent) run is depth 0, so the default
    # permits two further generations of agent-triggered-by-agent.
    agent_max_run_depth: int = 2

    # How long a run may sit in `running` before the reaper fails it (ADR-0014
    # §5, issue #402). A run only reaches `running` by being claimed, so one
    # that stays there past any possible invocation is a runtime that died
    # holding it: already paid for, no result recorded, and nothing waiting on
    # `agent.run.completed` will ever be released.
    #
    # The floor is AWS's own 900s Lambda cap, NOT the agent-runtime module's
    # configured `timeout` (300s). Deriving it from the platform ceiling rather
    # than from a second configurable number means raising the plugin's timeout
    # can never silently bring this below it and start reaping runs that are
    # still legitimately executing — which would be worse than the gap, since
    # the reap would then race a real completion. 1800s leaves an hour's slack
    # over the worst case while still bounding "stuck for ever" to half an hour.
    agent_run_stale_after_seconds: int = 1800

    # Application
    environment: str = "dev"
    log_level: str = "INFO"
    cors_origins: list[str] = ["http://localhost:3000"]


settings = Settings()
