import hashlib
import json
import random
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from urllib.parse import quote

from app.config import get_settings

_state_lock = RLock()
_runtime_failure_rate = None
_SAFE_COMPONENT_REGEX = re.compile(r"[^a-zA-Z0-9._-]+")


def _state_file_path() -> Path:
    settings = get_settings()
    configured = Path(settings.MOCK_S3_STATE_FILE)
    if configured.is_absolute():
        return configured
    backend_root = Path(__file__).resolve().parents[1]
    return backend_root / configured


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _default_state() -> dict:
    return {"uploads": {}, "completed": {}, "aborted": {}}


def _load_state() -> dict:
    path = _state_file_path()
    if not path.exists():
        return _default_state()

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return _default_state()


def _save_state(state: dict) -> None:
    path = _state_file_path()
    _ensure_parent(path)
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")


def reset_state() -> None:
    with _state_lock:
        _save_state(_default_state())


def set_runtime_failure_rate(rate: float) -> None:
    global _runtime_failure_rate
    _runtime_failure_rate = max(0.0, min(1.0, float(rate)))


def _failure_rate() -> float:
    if _runtime_failure_rate is not None:
        return _runtime_failure_rate
    return float(get_settings().MOCK_S3_PART_FAILURE_RATE)


def _sanitize_component(value: str, fallback: str = "unknown") -> str:
    raw = (value or "").strip().lower()
    cleaned = _SAFE_COMPONENT_REGEX.sub("-", raw).strip(".-")
    return cleaned or fallback


def _sanitize_filename(file_name: str, fallback: str = "file") -> str:
    raw = (file_name or "").replace("\\", "/").split("/")[-1].strip().lstrip(".")
    cleaned = _SAFE_COMPONENT_REGEX.sub("_", raw).strip("._")
    return cleaned or fallback


def start_multipart_upload(file_name: str, content_type: str, user_id: str = "anonymous") -> dict:
    safe_user_id = _sanitize_component(user_id, fallback="anonymous")
    safe_file_name = _sanitize_filename(file_name)
    date_prefix = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    unique_id = uuid.uuid4().hex[:12]

    upload_id = f"mock-{uuid.uuid4().hex}"
    file_key = f"medical-uploads/{safe_user_id}/{date_prefix}/{timestamp}_{unique_id}_{safe_file_name}"

    with _state_lock:
        state = _load_state()
        state["uploads"][upload_id] = {
            "file_key": file_key,
            "content_type": content_type,
            "parts": {},
            "status": "in_progress",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _save_state(state)

    return {"upload_id": upload_id, "file_key": file_key}


def generate_presigned_part_url(file_key: str, upload_id: str, part_number: int) -> str:
    return (
        "/api/upload/mock-upload-part"
        f"?upload_id={quote(upload_id)}"
        f"&file_key={quote(file_key)}"
        f"&part_number={part_number}"
    )


def upload_part(file_key: str, upload_id: str, part_number: int, body: bytes) -> str:
    if part_number < 1:
        raise ValueError("Invalid part number")

    if random.random() < _failure_rate():
        raise RuntimeError("Simulated transient mock upload failure")

    with _state_lock:
        state = _load_state()
        upload = state["uploads"].get(upload_id)
        if not upload:
            raise ValueError("NoSuchUpload")
        if upload.get("file_key") != file_key:
            raise ValueError("NoSuchKey")

        etag = f'"{hashlib.md5(body or b"").hexdigest()}"'
        upload["parts"][str(part_number)] = {
            "ETag": etag,
            "size": len(body or b""),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        _save_state(state)

    return etag


def complete_multipart_upload(file_key: str, upload_id: str, parts: list[dict]) -> dict:
    with _state_lock:
        state = _load_state()
        upload = state["uploads"].get(upload_id)
        if not upload:
            raise ValueError("NoSuchUpload")
        if upload.get("file_key") != file_key:
            raise ValueError("NoSuchKey")

        for part in parts:
            pn = str(part.get("PartNumber"))
            etag = part.get("ETag")
            stored = upload["parts"].get(pn)
            if not stored or stored.get("ETag") != etag:
                raise ValueError("InvalidPart")

        state["completed"][upload_id] = {
            "file_key": file_key,
            "parts": upload.get("parts", {}),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "location": f"mock://{file_key}",
        }
        state["uploads"].pop(upload_id, None)
        _save_state(state)

    return {
        "message": "Upload completed successfully",
        "location": f"mock://{file_key}",
    }


def abort_multipart_upload(file_key: str, upload_id: str) -> dict:
    with _state_lock:
        state = _load_state()
        upload = state["uploads"].get(upload_id)
        if not upload:
            raise ValueError("NoSuchUpload")
        if upload.get("file_key") != file_key:
            raise ValueError("NoSuchKey")

        state["aborted"][upload_id] = {
            "file_key": file_key,
            "aborted_at": datetime.now(timezone.utc).isoformat(),
        }
        state["uploads"].pop(upload_id, None)
        _save_state(state)

    return {"message": "Upload aborted successfully"}


def generate_presigned_get_url(file_key: str) -> str:
    return f"mock://{file_key}"


def get_upload(upload_id: str):
    with _state_lock:
        state = _load_state()
        return state["uploads"].get(upload_id)
