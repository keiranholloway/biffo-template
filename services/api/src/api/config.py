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

    # Application
    environment: str = "dev"
    log_level: str = "INFO"
    cors_origins: list[str] = ["http://localhost:3000"]


settings = Settings()
