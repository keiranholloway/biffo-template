from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BIFFO_", case_sensitive=False)

    # Database — sourced from Secrets Manager at runtime, never from env directly in prod
    database_url: str = "postgresql+asyncpg://localhost/biffo_dev"

    # Cognito
    cognito_user_pool_id: str = ""
    cognito_client_id: str = ""
    cognito_region: str = "us-east-1"

    # EventBridge
    event_bus_name: str = "biffo-events"
    aws_region: str = "us-east-1"

    # Application
    environment: str = "dev"
    log_level: str = "INFO"
    cors_origins: list[str] = ["http://localhost:3000"]


settings = Settings()
