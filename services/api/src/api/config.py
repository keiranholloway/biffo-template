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

    # Application
    environment: str = "dev"
    log_level: str = "INFO"
    cors_origins: list[str] = ["http://localhost:3000"]


settings = Settings()
