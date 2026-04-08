"""Application configuration and settings."""

from pathlib import Path
from typing import List, Optional

from pydantic import AnyHttpUrl, Field, validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings."""

    # Application
    APP_NAME: str = "@openfs/adapter-s3-api"
    DEBUG: bool = Field(default=False, env="DEBUG")
    ENVIRONMENT: str = Field(default="development", env="ENVIRONMENT")
    SECRET_KEY: str = Field("dev-secret-key-change-in-production", env="SECRET_KEY")
    API_PREFIX: str = "/api/v1"
    API_TITLE: str = "@openfs/adapter-s3-api"
    API_DESCRIPTION: str = "S3/MinIO management API for OpenFS — buckets, objects, streaming, IAM, search, and more"
    API_VERSION: str = "0.1.0"
    
    # CORS
    CORS_ORIGINS: List[str] = ["*"]
    ALLOWED_HOSTS: List[str] = ["*"]
    
    # MinIO
    MINIO_ENDPOINT: str = Field(..., env="MINIO_ENDPOINT")
    MINIO_ACCESS_KEY: str = Field(..., env="MINIO_ACCESS_KEY")
    MINIO_SECRET_KEY: str = Field(..., env="MINIO_SECRET_KEY")
    MINIO_SECURE: bool = Field(False, env="MINIO_SECURE")
    MINIO_REGION: str = Field("us-east-1", env="MINIO_REGION")
    
    # Security
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    ALGORITHM: str = "HS256"
    
    # Logging
    LOG_LEVEL: str = "INFO"
    
    # Rate limiting
    RATE_LIMIT_PER_MINUTE: int = 100
    
    class Config:
        """Pydantic config."""
        
        env_file = ".env"
        case_sensitive = True


# Create settings instance
settings = Settings()
