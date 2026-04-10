from pydantic_settings import BaseSettings
from functools import lru_cache
from pydantic import Field, field_validator


class Settings(BaseSettings):
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_REGION: str = "ap-south-1"
    S3_BUCKET_NAME: str = ""
    ENCRYPTION_KEY: str = ""
    PRESIGNED_URL_EXPIRY: int = 3600  # 1 hour
    KMS_KEY_ID: str = ""
    USE_MOCK_S3: bool = False
    MOCK_S3_STATE_FILE: str = "tmp/mock_s3_state.json"
    MOCK_S3_PART_FAILURE_RATE: float = Field(default=0.0, ge=0.0, le=1.0)
    UPLOAD_CLEANUP_INTERVAL_SECONDS: int = Field(default=300, ge=60, le=86400)
    
    # MongoDB + Auth Config
    MONGO_URI: str = Field(..., min_length=10)
    MONGO_DB_NAME: str = Field(default="medivault", min_length=1, max_length=64)
    JWT_SECRET_KEY: str = Field(..., min_length=32)  # must come from env/.env
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(default=60, ge=60, le=1440)
    CORS_ALLOW_ORIGINS: str = "http://localhost:5173"

    @field_validator("JWT_SECRET_KEY")
    @classmethod
    def validate_jwt_secret(cls, value: str) -> str:
        disallowed = {
            "supersecretkey",
            "default_secret",
            "changeme",
            "secret",
            "password",
        }
        if value.strip().lower() in disallowed:
            raise ValueError("JWT_SECRET_KEY is too weak. Use a strong random value.")
        return value

    @field_validator("MONGO_URI")
    @classmethod
    def validate_mongo_uri(cls, value: str) -> str:
        if not (value.startswith("mongodb://") or value.startswith("mongodb+srv://")):
            raise ValueError("MONGO_URI must start with mongodb:// or mongodb+srv://")
        return value

    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.CORS_ALLOW_ORIGINS.split(",") if origin.strip()]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "allow"}


@lru_cache()
def get_settings() -> Settings:
    return Settings()
