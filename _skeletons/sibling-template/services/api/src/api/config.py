from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Change this prefix to your own sibling's name if you want a more
    # specific env var namespace — just keep it consistent with
    # infra/main.tf's environment_variables block.
    model_config = SettingsConfigDict(env_prefix="SIBLING_", case_sensitive=False)

    # Cognito — deliberately the CORE project's pool/client, not a new one
    # (ADR-0007): this sibling verifies the same JWT the core portal issued,
    # so users get single sign-on across the core and every sibling for free.
    cognito_user_pool_id: str = ""
    cognito_client_id: str = ""
    cognito_region: str = "us-east-1"
    # Pre-loaded JWKS JSON string — set by Terraform at apply time in no-NAT
    # dev environments so the Lambda can verify JWTs without an outbound
    # call. If empty, the JWKS is fetched at runtime (requires NAT or a
    # cognito-idp VPC endpoint).
    cognito_jwks_json: str = ""

    # The core project's own API — the ONLY place this service is allowed to
    # get or persist data (ADR-0002). Never add a database client here.
    core_api_url: str = ""

    # NOT a free choice: this Lambda sits behind an HTTP API whose integration
    # timeout is 29s, and `core_client` retries once, so the ceiling is
    # 2 x this value < 29s. Twelve leaves comfortable room above core's measured
    # ~7.8s cold start (tabsii-platform#567) and still lands at 24s worst case.
    # Raising it past ~14 makes the gateway time out first, which returns a 504
    # with no message rather than the explained one core_client produces.
    core_api_timeout_seconds: float = 12.0

    environment: str = "dev"
    log_level: str = "INFO"
    cors_origins: list[str] = ["http://localhost:3000"]


settings = Settings()
