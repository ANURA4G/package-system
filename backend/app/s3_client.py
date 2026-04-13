import boto3
import uuid
import re
from datetime import datetime, timezone
from typing import List, Dict, Any
from functools import lru_cache
from botocore.config import Config
from app.config import get_settings
from app import mock_s3_service
from app.security_utils import sanitize_filename


_SAFE_COMPONENT_REGEX = re.compile(r"[^a-zA-Z0-9._-]+")


def _use_mock_s3() -> bool:
    return bool(get_settings().USE_MOCK_S3)


def _sanitize_path_component(value: str, fallback: str = "unknown") -> str:
    raw = (value or "").strip().lower()
    cleaned = _SAFE_COMPONENT_REGEX.sub("-", raw).strip(".-")
    return cleaned or fallback


def _sanitize_filename(file_name: str, fallback: str = "file") -> str:
    return sanitize_filename(file_name, fallback=fallback, max_length=160)


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


def create_s3_client(access_key: str, secret_key: str, region: str):
    """Create an S3 client from user-provided credentials."""
    return boto3.client(
        "s3",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=Config(
            signature_version='s3v4',
            s3={'addressing_style': 'virtual'}
        )
    )


def initiate_multipart_upload(
    file_name: str,
    content_type: str,
    user_id: str = "anonymous",
    s3_client: Any = None,
    bucket_name: str | None = None,
    use_kms: bool = False,
    kms_key_id: str | None = None,
) -> dict:
    """Start a multipart upload → returns upload_id + file_key."""
    if _use_mock_s3():
        return mock_s3_service.start_multipart_upload(file_name, content_type, user_id)

    if not bucket_name:
        raise ValueError("No bucket selected")
    if s3_client is None:
        raise ValueError("Bucket credentials context is required")

    s3 = s3_client
    bucket = bucket_name

    safe_user_id = _sanitize_path_component(user_id, fallback="anonymous")
    safe_file_name = _sanitize_filename(file_name)
    date_prefix = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    unique_id = uuid.uuid4().hex[:12]
    file_key = f"medical-uploads/{safe_user_id}/{date_prefix}/{timestamp}_{unique_id}_{safe_file_name}"

    create_args = {
        "Bucket": bucket,
        "Key": file_key,
    }
    if use_kms and kms_key_id:
        create_args["ServerSideEncryption"] = "aws:kms"
        create_args["SSEKMSKeyId"] = kms_key_id

    response = s3.create_multipart_upload(**create_args)

    return {"upload_id": response["UploadId"], "file_key": file_key}


def generate_presigned_url(
    file_key: str,
    upload_id: str,
    part_number: int,
    s3_client: Any = None,
    bucket_name: str | None = None,
) -> str:
    """Generate a pre-signed PUT URL for one chunk."""
    if _use_mock_s3():
        return mock_s3_service.generate_presigned_part_url(file_key, upload_id, part_number)

    settings = get_settings()
    if not bucket_name:
        raise ValueError("No bucket selected")
    if s3_client is None:
        raise ValueError("Bucket credentials context is required")

    s3 = s3_client
    bucket = bucket_name

    return s3.generate_presigned_url(
        ClientMethod="upload_part",
        Params={
            "Bucket": bucket,
            "Key": file_key,
            "UploadId": upload_id,
            "PartNumber": part_number,
        },
        ExpiresIn=settings.PRESIGNED_URL_EXPIRY,
    )


def complete_multipart_upload(
    file_key: str,
    upload_id: str,
    parts: List[Dict],
    s3_client: Any = None,
    bucket_name: str | None = None,
) -> dict:
    """Finalize the upload by sending sorted ETags to S3."""
    if _use_mock_s3():
        return mock_s3_service.complete_multipart_upload(file_key, upload_id, parts)

    if not bucket_name:
        raise ValueError("No bucket selected")
    if s3_client is None:
        raise ValueError("Bucket credentials context is required")

    s3 = s3_client
    bucket = bucket_name

    sorted_parts = sorted(parts, key=lambda p: p["PartNumber"])

    response = s3.complete_multipart_upload(
        Bucket=bucket,
        Key=file_key,
        UploadId=upload_id,
        MultipartUpload={"Parts": sorted_parts},
    )

    return {
        "message": "Upload completed successfully",
        "location": response.get("Location", ""),
    }


def abort_multipart_upload(
    file_key: str,
    upload_id: str,
    s3_client: Any = None,
    bucket_name: str | None = None,
) -> dict:
    """Abort an in-progress upload and clean up S3 parts."""
    if _use_mock_s3():
        return mock_s3_service.abort_multipart_upload(file_key, upload_id)

    if not bucket_name:
        raise ValueError("No bucket selected")
    if s3_client is None:
        raise ValueError("Bucket credentials context is required")

    s3 = s3_client
    bucket = bucket_name

    s3.abort_multipart_upload(
        Bucket=bucket,
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
    bucket = settings.S3_BUCKET_NAME

    return s3.generate_presigned_url(
        ClientMethod="get_object",
        Params={
            "Bucket": bucket,
            "Key": file_key,
        },
        ExpiresIn=settings.PRESIGNED_URL_EXPIRY,
    )


def generate_presigned_get_url_with_context(
    file_key: str,
    *,
    s3_client: Any,
    bucket_name: str,
) -> str:
    """Generate pre-signed GET URL with explicit per-user bucket credentials context."""
    if _use_mock_s3():
        return mock_s3_service.generate_presigned_get_url(file_key)

    settings = get_settings()
    s3 = s3_client

    return s3.generate_presigned_url(
        ClientMethod="get_object",
        Params={
            "Bucket": bucket_name,
            "Key": file_key,
        },
        ExpiresIn=settings.PRESIGNED_URL_EXPIRY,
    )


def delete_object_with_context(
    file_key: str,
    *,
    s3_client: Any,
    bucket_name: str,
) -> dict:
    """Delete an object using explicit per-user bucket credentials context."""
    if _use_mock_s3():
        return mock_s3_service.delete_object(file_key)

    s3 = s3_client
    s3.delete_object(Bucket=bucket_name, Key=file_key)
    return {"message": "File deleted successfully", "file_key": file_key}


def delete_prefix_with_context(
    prefix: str,
    *,
    s3_client: Any,
    bucket_name: str,
) -> dict:
    """Delete all objects under a prefix path using explicit per-user bucket credentials context."""
    normalized_prefix = (prefix or "").strip()
    if not normalized_prefix:
        raise ValueError("Invalid prefix")

    if _use_mock_s3():
        return mock_s3_service.delete_prefix(normalized_prefix)

    s3 = s3_client
    paginator = s3.get_paginator("list_objects_v2")
    deleted_count = 0

    for page in paginator.paginate(Bucket=bucket_name, Prefix=normalized_prefix):
        objects = page.get("Contents", [])
        if not objects:
            continue

        keys_batch = [{"Key": obj.get("Key")} for obj in objects if obj.get("Key")]
        if not keys_batch:
            continue

        s3.delete_objects(
            Bucket=bucket_name,
            Delete={"Objects": keys_batch, "Quiet": True},
        )
        deleted_count += len(keys_batch)

    return {
        "message": "Prefix deleted successfully",
        "prefix": normalized_prefix,
        "deleted_count": deleted_count,
    }


def upload_part_mock(file_key: str, upload_id: str, part_number: int, body: bytes) -> str:
    if not _use_mock_s3():
        raise RuntimeError("Mock S3 mode is disabled")
    return mock_s3_service.upload_part(file_key, upload_id, part_number, body)
