import boto3
import uuid
import re
from datetime import datetime, timezone
from typing import List, Dict
from functools import lru_cache
from botocore.config import Config
from app.config import get_settings
from app import mock_s3_service


_SAFE_COMPONENT_REGEX = re.compile(r"[^a-zA-Z0-9._-]+")


def _use_mock_s3() -> bool:
    return bool(get_settings().USE_MOCK_S3)


def _sanitize_path_component(value: str, fallback: str = "unknown") -> str:
    raw = (value or "").strip().lower()
    cleaned = _SAFE_COMPONENT_REGEX.sub("-", raw).strip(".-")
    return cleaned or fallback


def _sanitize_filename(file_name: str, fallback: str = "file") -> str:
    # Keep only basename to avoid user-controlled path fragments like ../
    raw = (file_name or "").replace("\\", "/").split("/")[-1].strip().lstrip(".")
    cleaned = _SAFE_COMPONENT_REGEX.sub("_", raw).strip("._")
    if not cleaned:
        return fallback

    if len(cleaned) > 160:
        if "." in cleaned:
            stem, ext = cleaned.rsplit(".", 1)
            cleaned = f"{stem[:140]}.{ext[:16]}"
        else:
            cleaned = cleaned[:160]

    return cleaned


@lru_cache()
def _get_s3_client():
    """Create and cache a boto3 S3 client with explicit regional endpoints."""
    settings = get_settings()
    return boto3.client(
        "s3",
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
        region_name=settings.AWS_REGION,
        config=Config(
            signature_version='s3v4',
            s3={'addressing_style': 'virtual'}
        )
    )


def initiate_multipart_upload(file_name: str, content_type: str, user_id: str = "anonymous") -> dict:
    """Start a multipart upload → returns upload_id + file_key."""
    if _use_mock_s3():
        return mock_s3_service.start_multipart_upload(file_name, content_type, user_id)

    settings = get_settings()
    s3 = _get_s3_client()

    safe_user_id = _sanitize_path_component(user_id, fallback="anonymous")
    safe_file_name = _sanitize_filename(file_name)
    date_prefix = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    unique_id = uuid.uuid4().hex[:12]
    file_key = f"medical-uploads/{safe_user_id}/{date_prefix}/{timestamp}_{unique_id}_{safe_file_name}"

    response = s3.create_multipart_upload(
        Bucket=settings.S3_BUCKET_NAME,
        Key=file_key,
        ContentType=content_type,
    )

    return {"upload_id": response["UploadId"], "file_key": file_key}


def generate_presigned_url(file_key: str, upload_id: str, part_number: int) -> str:
    """Generate a pre-signed PUT URL for one chunk."""
    if _use_mock_s3():
        return mock_s3_service.generate_presigned_part_url(file_key, upload_id, part_number)

    settings = get_settings()
    s3 = _get_s3_client()

    return s3.generate_presigned_url(
        ClientMethod="upload_part",
        Params={
            "Bucket": settings.S3_BUCKET_NAME,
            "Key": file_key,
            "UploadId": upload_id,
            "PartNumber": part_number,
        },
        ExpiresIn=settings.PRESIGNED_URL_EXPIRY,
    )


def complete_multipart_upload(
    file_key: str, upload_id: str, parts: List[Dict]
) -> dict:
    """Finalize the upload by sending sorted ETags to S3."""
    if _use_mock_s3():
        return mock_s3_service.complete_multipart_upload(file_key, upload_id, parts)

    settings = get_settings()
    s3 = _get_s3_client()

    sorted_parts = sorted(parts, key=lambda p: p["PartNumber"])

    response = s3.complete_multipart_upload(
        Bucket=settings.S3_BUCKET_NAME,
        Key=file_key,
        UploadId=upload_id,
        MultipartUpload={"Parts": sorted_parts},
    )

    return {
        "message": "Upload completed successfully",
        "location": response.get("Location", ""),
    }


def abort_multipart_upload(file_key: str, upload_id: str) -> dict:
    """Abort an in-progress upload and clean up S3 parts."""
    if _use_mock_s3():
        return mock_s3_service.abort_multipart_upload(file_key, upload_id)

    settings = get_settings()
    s3 = _get_s3_client()

    s3.abort_multipart_upload(
        Bucket=settings.S3_BUCKET_NAME,
        Key=file_key,
        UploadId=upload_id,
    )

    return {"message": "Upload aborted successfully"}


def generate_presigned_get_url(file_key: str) -> str:
    """Generate a pre-signed GET URL so the browser can fetch the file directly."""
    if _use_mock_s3():
        return mock_s3_service.generate_presigned_get_url(file_key)

    settings = get_settings()
    s3 = _get_s3_client()

    return s3.generate_presigned_url(
        ClientMethod="get_object",
        Params={
            "Bucket": settings.S3_BUCKET_NAME,
            "Key": file_key,
        },
        ExpiresIn=settings.PRESIGNED_URL_EXPIRY,
    )


def upload_part_mock(file_key: str, upload_id: str, part_number: int, body: bytes) -> str:
    if not _use_mock_s3():
        raise RuntimeError("Mock S3 mode is disabled")
    return mock_s3_service.upload_part(file_key, upload_id, part_number, body)
