from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BIFFO_", case_sensitive=False)

    # Database — local dev: set database_url directly.
    # AWS: set db_secret_arn (Secrets Manager) + db_host (proxy or RDS endpoint).
    database_url: str = "postgresql+asyncpg://localhost/biffo_dev"
    db_secret_arn: str = ""
    db_host: str = ""

    # Cognito
    cognito_user_pool_id: str = ""
    cognito_client_id: str = ""
    cognito_region: str = "us-east-1"

    # EventBridge
    event_bus_name: str = "biffo-events"

    # Application
    environment: str = "dev"
    log_level: str = "INFO"
    cors_origins: list[str] = ["http://localhost:3000"]


settings = Settings()
