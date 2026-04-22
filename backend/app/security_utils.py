import re
import unicodedata

_SAFE_FILENAME_REGEX = re.compile(r"[^a-zA-Z0-9._-]+")
_MULTI_UNDERSCORE_REGEX = re.compile(r"_+")


def sanitize_filename(file_name: str, *, fallback: str = "file", max_length: int = 255) -> str:
    """Sanitize user-provided filenames for storage and object-key usage.

    Security properties:
    - removes path traversal by keeping basename only
    - normalizes unicode (NFKC)
    - keeps only [a-zA-Z0-9._-]
    - bounds final length
    - guarantees non-empty output
    """
    normalized_fallback = _SAFE_FILENAME_REGEX.sub("_", (fallback or "file")).strip("._-") or "file"
    limit = max(1, int(max_length or 255))

    raw = unicodedata.normalize("NFKC", str(file_name or ""))
    raw = raw.replace("\x00", "").replace("\\", "/")
    raw = raw.split("/")[-1].strip()

    if raw in {"", ".", ".."}:
        raw = ""

    safe = _SAFE_FILENAME_REGEX.sub("_", raw)
    safe = _MULTI_UNDERSCORE_REGEX.sub("_", safe).strip("._-")

    if not safe:
        safe = normalized_fallback

    if len(safe) <= limit:
        return safe

    if "." in safe:
        stem, ext = safe.rsplit(".", 1)
        ext = ext[: min(20, max(1, limit - 2))]
        suffix = f".{ext}" if ext else ""
        remaining = max(1, limit - len(suffix))
        stem = (stem[:remaining]).rstrip("._-") or normalized_fallback
        return f"{stem}{suffix}"[:limit]

    return safe[:limit]
