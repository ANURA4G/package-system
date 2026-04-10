from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


@lru_cache()
def _get_fernet() -> Fernet:
    key = (get_settings().ENCRYPTION_KEY or "").strip()
    if not key:
        raise ValueError("ENCRYPTION_KEY is not configured")
    return Fernet(key.encode("utf-8"))


def encrypt_value(text: str) -> str:
    if text is None:
        raise ValueError("Value cannot be empty")
    token = _get_fernet().encrypt(text.encode("utf-8"))
    return token.decode("utf-8")


def decrypt_value(text: str) -> str:
    if text is None:
        raise ValueError("Value cannot be empty")
    try:
        value = _get_fernet().decrypt(text.encode("utf-8"))
    except InvalidToken as e:
        raise ValueError("Invalid encrypted value") from e
    return value.decode("utf-8")