import logging
from urllib.parse import urlparse

from pymongo import MongoClient, ASCENDING
from app.config import get_settings

settings = get_settings()

logger = logging.getLogger(__name__)


def _safe_mongo_target(uri: str) -> str:
    try:
        parsed = urlparse(uri)
        host = parsed.hostname or "unknown-host"
        port = f":{parsed.port}" if parsed.port else ""
        return f"{host}{port}"
    except Exception:
        return "unknown-host"

client = MongoClient(settings.MONGO_URI, serverSelectionTimeoutMS=5000)
db = client[settings.MONGO_DB_NAME]
users_collection = db["users"]
upload_sessions_collection = db["upload_sessions"]
uploads_collection = db["uploads"]


def check_database_connection() -> None:
    try:
        client.admin.command("ping")
        upload_sessions_collection.create_index(
            [("expires_at", ASCENDING)],
            expireAfterSeconds=0,
            name="upload_sessions_expires_at_ttl",
        )
        upload_sessions_collection.create_index(
            [("status", ASCENDING), ("expires_at", ASCENDING)],
            name="upload_sessions_status_expires_idx",
        )
        logger.info(
            "MongoDB connection successful target=%s database=%s",
            _safe_mongo_target(settings.MONGO_URI),
            settings.MONGO_DB_NAME,
        )
        logger.info("MongoDB TTL index ensured collection=upload_sessions field=expires_at")
    except Exception as e:
        logger.exception(
            "MongoDB connection failed target=%s",
            _safe_mongo_target(settings.MONGO_URI),
        )
        raise RuntimeError("MongoDB connection failed") from e
