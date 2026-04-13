import logging
import re
from datetime import datetime, timezone, timedelta
import boto3
from fastapi import APIRouter, HTTPException, Depends, Request, Response, Query
from bson import ObjectId
from bson.errors import InvalidId
from botocore.exceptions import (
    ClientError,
    BotoCoreError,
    EndpointConnectionError,
    ConnectTimeoutError,
    ReadTimeoutError,
)
from app.schemas import (
    StartUploadRequest, StartUploadResponse,
    PresignedUrlRequest, PresignedUrlResponse,
    CompleteUploadRequest, CompleteUploadResponse,
    AbortUploadRequest, AbortUploadResponse,
    FileUrlRequest, FileUrlResponse,
    DeleteFileResponse,
    DeleteFileByKeyRequest,
    DeleteFileByKeyResponse,
    DeleteHistoryRecordResponse,
    ClearHistoryResponse,
    UpdatePartRequest, UpdatePartResponse,
    ResumeSessionResponse,
    AddBucketRequest, AddBucketResponse,
    BucketSummary,
    UpdateBucketRequest,
    DeleteBucketResponse,
    BucketUsageResponse,
    BucketFileListResponse,
)
from app.s3_client import (
    create_s3_client,
    initiate_multipart_upload,
    generate_presigned_url,
    complete_multipart_upload,
    abort_multipart_upload,
    generate_presigned_get_url_with_context,
    delete_object_with_context,
    delete_prefix_with_context,
    upload_part_mock,
)
from app.auth import get_current_user
from app.database import upload_sessions_collection, uploads_collection, bucket_credentials_collection
from app.config import get_settings
from app.rate_limit import limiter
from app.encryption_utils import encrypt_value, decrypt_value

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/upload", tags=["Upload"])
CHUNK_SIZE_BYTES = 5 * 1024 * 1024
ALLOWED_UPLOAD_EXTENSIONS = {"dcm", "dicom", "jpg", "jpeg", "png", "pdf", "zip"}
BUCKET_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
DEFAULT_BUCKET_SIZE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024


def _get_available_s3_regions() -> set[str]:
    session = boto3.session.Session()
    return set(session.get_available_regions("s3"))


def _is_valid_s3_bucket_name(bucket_name: str) -> bool:
    if not bucket_name or len(bucket_name) < 3 or len(bucket_name) > 63:
        return False
    if not BUCKET_NAME_PATTERN.match(bucket_name):
        return False
    if ".." in bucket_name or ".-" in bucket_name or "-." in bucket_name:
        return False
    # Buckets cannot look like an IPv4 address.
    if re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", bucket_name):
        return False
    return True


def _calculate_total_parts(file_size: int) -> int:
    if file_size <= 0:
        return 0
    return (file_size + CHUNK_SIZE_BYTES - 1) // CHUNK_SIZE_BYTES


def _extract_extension(file_name: str) -> str:
    if not file_name or "." not in file_name:
        return ""
    return file_name.rsplit(".", 1)[-1].lower().strip()


def _is_folder_relative_path(file_name: str) -> bool:
    return "/" in (file_name or "") or "\\" in (file_name or "")


def _extract_uploaded_part_numbers(parts_uploaded, upload_id: str, username: str) -> list[int]:
    unique_numbers = set()
    for part in parts_uploaded or []:
        if not isinstance(part, dict):
            logger.warning(
                "Skipping malformed uploaded part (non-dict) upload_id=%s user_id=%s",
                upload_id,
                username,
            )
            continue

        raw_part_number = part.get("PartNumber")
        try:
            part_number = int(raw_part_number)
        except (TypeError, ValueError):
            logger.warning(
                "Skipping malformed uploaded part number upload_id=%s user_id=%s value=%s",
                upload_id,
                username,
                raw_part_number,
            )
            continue

        if part_number < 1:
            logger.warning(
                "Skipping invalid uploaded part number upload_id=%s user_id=%s value=%s",
                upload_id,
                username,
                part_number,
            )
            continue

        unique_numbers.add(part_number)

    return sorted(unique_numbers)


def _normalize_uploaded_part_numbers(raw_part_numbers, upload_id: str, username: str) -> list[int]:
    unique_numbers = set()
    for raw_part_number in raw_part_numbers or []:
        try:
            part_number = int(raw_part_number)
        except (TypeError, ValueError):
            logger.warning(
                "Skipping malformed uploaded_part_numbers value upload_id=%s user_id=%s value=%s",
                upload_id,
                username,
                raw_part_number,
            )
            continue

        if part_number < 1:
            logger.warning(
                "Skipping invalid uploaded_part_numbers value upload_id=%s user_id=%s value=%s",
                upload_id,
                username,
                part_number,
            )
            continue

        unique_numbers.add(part_number)

    return sorted(unique_numbers)

def _handle_s3_error(action: str, e: Exception):
    if isinstance(e, HTTPException):
        raise e

    if isinstance(e, ValueError):
        code = str(e)
        if code in ("NoSuchUpload", "NoSuchKey", "InvalidPart", "InvalidRequest"):
            raise HTTPException(status_code=400, detail=f"Bad upload request: {code}")
        raise HTTPException(status_code=400, detail=f"Bad upload request: {code}")

    if isinstance(e, ClientError):
        code = e.response["Error"]["Code"]
        msg = e.response["Error"]["Message"]
        logger.warning("%s failed with S3 error code=%s message=%s", action, code, msg)

        bad_request_codes = {
            "NoSuchUpload",
            "NoSuchKey",
            "InvalidPart",
            "InvalidPartOrder",
            "EntityTooSmall",
            "InvalidRequest",
            "InvalidKeyId",
        }
        forbidden_codes = {"AccessDenied"}
        unauthorized_codes = {"SignatureDoesNotMatch", "InvalidAccessKeyId"}

        if code in bad_request_codes:
            raise HTTPException(status_code=400, detail=f"Bad upload request: {msg}")
        if code in forbidden_codes:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"Forbidden to perform {action.lower()} operation. "
                    "Check bucket IAM policy for required permissions (for delete: s3:DeleteObject)."
                ),
            )
        if code in unauthorized_codes:
            raise HTTPException(status_code=401, detail="Unauthorized to perform upload operation")

        raise HTTPException(status_code=502, detail=f"S3 {code}: {msg}")

    if isinstance(e, BotoCoreError):
        logger.exception("%s failed with AWS SDK transport error", action)
        raise HTTPException(status_code=502, detail=f"AWS error: {str(e)}")

    logger.exception("%s failed unexpectedly", action)
    raise HTTPException(status_code=500, detail=f"{action} failed: {str(e)}")


def _normalize_bucket_selector(
    bucket_id: str | None,
    bucket_name: str | None,
) -> tuple[str | None, str | None]:
    normalized_bucket_id = (bucket_id or "").strip() or None
    normalized_bucket_name = (bucket_name or "").strip() or None
    return normalized_bucket_id, normalized_bucket_name


def _resolve_user_bucket_record(
    username: str,
    bucket_id: str | None = None,
    bucket_name: str | None = None,
):
    normalized_bucket_id, normalized_bucket_name = _normalize_bucket_selector(bucket_id, bucket_name)
    if not normalized_bucket_id and not normalized_bucket_name:
        raise HTTPException(status_code=400, detail="No bucket selected")

    query = {"user_id": username}
    if normalized_bucket_id:
        try:
            query["_id"] = ObjectId(normalized_bucket_id)
        except (InvalidId, TypeError):
            raise HTTPException(status_code=400, detail="Invalid bucket id")
    if normalized_bucket_name:
        query["bucket_name"] = normalized_bucket_name

    bucket_record = bucket_credentials_collection.find_one(query, sort=[("created_at", -1)])
    if not bucket_record:
        raise HTTPException(status_code=404, detail="Selected bucket not found")

    return bucket_record


def _get_user_bucket_context(
    username: str,
    bucket_id: str | None = None,
    bucket_name: str | None = None,
):
    bucket_record = _resolve_user_bucket_record(username, bucket_id=bucket_id, bucket_name=bucket_name)

    resolved_bucket_name = (bucket_record.get("bucket_name") or "").strip()
    if not _is_valid_s3_bucket_name(resolved_bucket_name):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Saved bucket name '{resolved_bucket_name}' is invalid. "
                "Delete it and add a valid S3 bucket name."
            ),
        )

    use_kms = bool(bucket_record.get("use_kms", False))
    kms_key_id = (bucket_record.get("kms_key_id") or "").strip() or None
    if use_kms and not kms_key_id:
        raise HTTPException(status_code=400, detail="KMS key is required when KMS encryption is enabled for selected bucket")

    if get_settings().USE_MOCK_S3:
        return None, resolved_bucket_name, str(bucket_record["_id"]), use_kms, kms_key_id

    try:
        access_key = decrypt_value(bucket_record["access_key_encrypted"])
        secret_key = decrypt_value(bucket_record["secret_key_encrypted"])
    except ValueError as e:
        raise HTTPException(status_code=500, detail="Stored bucket credentials are invalid") from e

    configured_region = (bucket_record.get("region") or "").strip()
    available_regions = _get_available_s3_regions()
    if configured_region not in available_regions:
        detected_region = _discover_bucket_region(access_key, secret_key, resolved_bucket_name)
        if not detected_region:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid AWS region '{configured_region}' for bucket '{resolved_bucket_name}'. "
                    "Delete and re-add bucket with a valid region (e.g. ap-south-1)."
                ),
            )

        bucket_credentials_collection.update_one(
            {"_id": bucket_record["_id"]},
            {
                "$set": {
                    "region": detected_region,
                    "validation_status": "verified",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )
        configured_region = detected_region

    client = create_s3_client(access_key, secret_key, configured_region)
    return client, resolved_bucket_name, str(bucket_record["_id"]), use_kms, kms_key_id


def _extract_bucket_region_from_error(error: ClientError) -> str | None:
    headers = error.response.get("ResponseMetadata", {}).get("HTTPHeaders", {}) or {}
    region = headers.get("x-amz-bucket-region")
    if not region:
        return None
    parsed_region = str(region).strip()
    return parsed_region or None


def _discover_bucket_region(access_key: str, secret_key: str, bucket_name: str) -> str | None:
    try:
        discovery_client = boto3.client(
            "s3",
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name="us-east-1",
        )
        discovery_client.head_bucket(Bucket=bucket_name)
        return "us-east-1"
    except ClientError as error:
        return _extract_bucket_region_from_error(error)
    except (EndpointConnectionError, ConnectTimeoutError, ReadTimeoutError, BotoCoreError):
        return None


def _recover_upload_record_reference(username: str, upload_record: dict) -> dict | None:
    """Try to recover file_id/file_key for legacy history records from completed sessions."""
    record_file_id = (upload_record.get("file_id") or "").strip() or None
    record_file_key = (upload_record.get("file_key") or "").strip() or None
    if record_file_id and record_file_key:
        return {
            "file_id": record_file_id,
            "file_key": record_file_key,
            "bucket_id": (upload_record.get("bucket_id") or "").strip() or None,
            "bucket_name": (upload_record.get("bucket_name") or upload_record.get("bucket") or "").strip() or None,
        }

    filename = (upload_record.get("filename") or "").strip()
    checksum = (upload_record.get("checksum") or "").strip()
    try:
        size = int(upload_record.get("size", 0) or 0)
    except (TypeError, ValueError):
        size = 0

    session_query = {
        "user_id": username,
        "status": "completed",
        "file_key": {"$exists": True, "$ne": ""},
    }
    if filename:
        session_query["filename"] = filename
    if size > 0:
        session_query["size"] = size
    if checksum:
        session_query["checksum"] = checksum

    session = upload_sessions_collection.find_one(session_query, sort=[("completed_at", -1)])
    if not session:
        # Relax query if checksum was missing or changed.
        relaxed_query = {
            "user_id": username,
            "status": "completed",
            "file_key": {"$exists": True, "$ne": ""},
        }
        if filename:
            relaxed_query["filename"] = filename
        if size > 0:
            relaxed_query["size"] = size
        session = upload_sessions_collection.find_one(relaxed_query, sort=[("completed_at", -1)])

    if not session:
        return None

    recovered = {
        "file_id": (session.get("file_id") or "").strip() or None,
        "file_key": (session.get("file_key") or "").strip() or None,
        "bucket_id": (session.get("bucket_id") or "").strip() or None,
        "bucket_name": (session.get("bucket_name") or "").strip() or None,
    }

    if not recovered["file_key"]:
        return None

    uploads_collection.update_one(
        {"_id": upload_record["_id"], "user_id": username},
        {
            "$set": {
                "file_id": recovered["file_id"],
                "file_key": recovered["file_key"],
                "bucket_id": recovered["bucket_id"],
                "bucket_name": recovered["bucket_name"] or upload_record.get("bucket_name") or upload_record.get("bucket"),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        },
    )

    return recovered


def _raise_bucket_validation_error(error: ClientError):
    details = error.response.get("Error", {})
    code = str(details.get("Code", ""))
    status = int(error.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0))

    invalid_credential_codes = {
        "InvalidAccessKeyId",
        "SignatureDoesNotMatch",
        "AuthFailure",
        "UnrecognizedClientException",
    }
    if code in invalid_credential_codes:
        raise HTTPException(status_code=401, detail="Invalid AWS credentials")

    if code in {"NoSuchBucket", "NotFound"} or status == 404:
        raise HTTPException(status_code=404, detail="Bucket not found")

    if code == "InvalidBucketName":
        raise HTTPException(status_code=400, detail="Invalid S3 bucket name")

    if code in {"AccessDenied", "AllAccessDisabled"} or status == 403:
        raise HTTPException(status_code=403, detail="Access denied to bucket")

    if code in {"AuthorizationHeaderMalformed", "PermanentRedirect"}:
        detected_region = _extract_bucket_region_from_error(error)
        if detected_region:
            raise HTTPException(
                status_code=400,
                detail=f"Bucket region mismatch. Use region '{detected_region}'",
            )

    raise HTTPException(status_code=400, detail="Unable to validate bucket credentials")


def _parse_uploads_query_timestamp(value: str, field_name: str) -> str:
    raw_value = (value or "").strip()
    if not raw_value:
        raise HTTPException(status_code=400, detail=f"{field_name} cannot be empty")

    try:
        parsed_dt = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid {field_name} format. Use ISO timestamp")

    if parsed_dt.tzinfo is None:
        parsed_dt = parsed_dt.replace(tzinfo=timezone.utc)

    return parsed_dt.astimezone(timezone.utc).isoformat()


@router.post("/start-upload", response_model=StartUploadResponse)
@limiter.limit("30/minute")
async def start_upload(request: Request, payload: StartUploadRequest, username: str = Depends(get_current_user)):
    try:
        extension = _extract_extension(payload.file_name)
        if extension not in ALLOWED_UPLOAD_EXTENSIONS and not _is_folder_relative_path(payload.file_name):
            raise HTTPException(
                status_code=415,
                detail="Unsupported file extension. Allowed extensions: .dcm, .dicom, .jpg, .jpeg, .png, .pdf, .zip",
            )

        selected_bucket_id, selected_bucket_name = _normalize_bucket_selector(payload.bucket_id, payload.bucket_name)
        s3_client, bucket_name, bucket_id, use_kms, kms_key_id = _get_user_bucket_context(
            username,
            bucket_id=selected_bucket_id,
            bucket_name=selected_bucket_name,
        )
        result = initiate_multipart_upload(
            payload.file_name,
            payload.content_type,
            username,
            s3_client=s3_client,
            bucket_name=bucket_name,
            use_kms=use_kms,
            kms_key_id=kms_key_id,
        )
        total_parts = _calculate_total_parts(payload.size)
        
        upload_sessions_collection.insert_one({
            "user_id": username,
            "file_id": payload.file_id,
            "filename": payload.file_name,
            "bucket_id": bucket_id,
            "bucket_name": bucket_name,
            "use_kms": use_kms,
            "kms_key_id": kms_key_id,
            "size": payload.size,
            "checksum": payload.checksum,
            "total_parts": total_parts,
            "upload_id": result["upload_id"],
            "file_key": result["file_key"],
            "uploaded_part_numbers": [],
            "parts_uploaded": [],
            "status": "in_progress",
            "expires_at": datetime.now(timezone.utc) + timedelta(hours=24),
            "created_at": datetime.now(timezone.utc).isoformat()
        })

        logger.info(
            "Started upload session user_id=%s file_id=%s upload_id=%s requested_bucket_id=%s requested_bucket_name=%s resolved_bucket_id=%s resolved_bucket_name=%s use_kms=%s total_parts=%s",
            username,
            payload.file_id,
            result["upload_id"],
            selected_bucket_id,
            selected_bucket_name,
            bucket_id,
            bucket_name,
            use_kms,
            total_parts,
        )
        
        return result
    except Exception as e:
        _handle_s3_error("Start upload", e)


@router.get("/resume-session", response_model=ResumeSessionResponse)
@limiter.limit("120/minute")
async def resume_session(
    request: Request,
    file_id: str,
    bucket_id: str | None = Query(default=None),
    bucket_name: str | None = Query(default=None),
    username: str = Depends(get_current_user),
):
    selected_bucket = _resolve_user_bucket_record(username, bucket_id=bucket_id, bucket_name=bucket_name)
    selected_bucket_id = str(selected_bucket["_id"])
    selected_bucket_name = selected_bucket.get("bucket_name")
    logger.info(
        "Resume session requested user_id=%s file_id=%s requested_bucket_id=%s requested_bucket_name=%s",
        username,
        file_id,
        selected_bucket_id,
        selected_bucket_name,
    )

    try:
        session_query = {
            "user_id": username,
            "file_id": file_id,
            "status": "in_progress",
            "bucket_name": selected_bucket_name,
        }
        session_query["$or"] = [
            {"bucket_id": selected_bucket_id},
            {"bucket_id": {"$exists": False}},
        ]

        session = upload_sessions_collection.find_one(session_query, sort=[("_id", -1)])
    except Exception as e:
        logger.exception("Resume session query failed user_id=%s file_id=%s", username, file_id)
        raise HTTPException(status_code=500, detail="Failed to fetch upload session") from e

    if not session:
        logger.info("No active session found user_id=%s file_id=%s", username, file_id)
        return {
            "has_session": False,
            "upload_id": None,
            "file_key": None,
            "bucket_id": None,
            "bucket_name": None,
            "uploaded_part_numbers": [],
            "total_parts": 0,
        }

    parts_uploaded = session.get("parts_uploaded", [])
    upload_id = session.get("upload_id", "")
    from_set = _normalize_uploaded_part_numbers(
        session.get("uploaded_part_numbers", []),
        upload_id=upload_id,
        username=username,
    )
    from_parts = _extract_uploaded_part_numbers(
        parts_uploaded,
        upload_id=upload_id,
        username=username,
    )
    uploaded_part_numbers = sorted(set(from_set).union(from_parts))
    total_parts = int(session.get("total_parts", 0))

    logger.info(
        "Resume session found user_id=%s file_id=%s upload_id=%s uploaded_parts=%s total_parts=%s",
        username,
        file_id,
        session.get("upload_id"),
        len(uploaded_part_numbers),
        total_parts,
    )

    return {
        "has_session": True,
        "upload_id": session["upload_id"],
        "file_key": session["file_key"],
        "bucket_id": session.get("bucket_id"),
        "bucket_name": session.get("bucket_name"),
        "uploaded_part_numbers": uploaded_part_numbers,
        "total_parts": total_parts,
    }


@router.post("/update-part", response_model=UpdatePartResponse)
@limiter.limit("600/minute")
async def update_part(request: Request, payload: UpdatePartRequest, username: str = Depends(get_current_user)):
    session_filter = {
        "upload_id": payload.upload_id,
        "user_id": username,
    }

    session = upload_sessions_collection.find_one(session_filter, {"status": 1, "file_id": 1, "file_key": 1})

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.get("status") != "in_progress":
        # Allow idempotent late-arriving retries after completion/abort when the same part was already stored.
        recorded_part = upload_sessions_collection.find_one(
            {
                **session_filter,
                "parts_uploaded": {"$elemMatch": {"PartNumber": payload.part_number, "ETag": payload.etag}},
            },
            {"_id": 1},
        )
        if recorded_part:
            logger.info(
                "Late idempotent update-part ignored for upload_id=%s user_id=%s part=%s",
                payload.upload_id,
                username,
                payload.part_number,
            )
            return {"message": "Part already recorded"}
        raise HTTPException(status_code=409, detail="Upload session is not active")

    if session.get("file_id") != payload.file_id or session.get("file_key") != payload.file_key:
        raise HTTPException(status_code=400, detail="Session identifiers mismatch")
        
    part_data = {"PartNumber": payload.part_number, "ETag": payload.etag}

    try:
        # Track completed part numbers in an idempotent set for safe retries.
        number_update = upload_sessions_collection.update_one(
            {**session_filter, "status": "in_progress"},
            {"$addToSet": {"uploaded_part_numbers": payload.part_number}},
        )

        if number_update.matched_count == 0:
            raise HTTPException(status_code=409, detail="Upload session is not active")

        # Persist ETag metadata only if this part number has not been recorded yet.
        part_update = upload_sessions_collection.update_one(
            {
                **session_filter,
                "status": "in_progress",
                "parts_uploaded.PartNumber": {"$ne": payload.part_number},
            },
            {"$push": {"parts_uploaded": part_data}},
        )

        if part_update.modified_count == 0:
            logger.info(
                "Idempotent retry detected for upload_id=%s user_id=%s part=%s",
                payload.upload_id,
                username,
                payload.part_number,
            )
            return {"message": "Part already recorded"}

        return {"message": "Part updated"}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "Failed to update part upload_id=%s user_id=%s part=%s",
            payload.upload_id,
            username,
            payload.part_number,
        )
        raise HTTPException(status_code=500, detail="Failed to update part") from e


@router.post("/presigned-url", response_model=PresignedUrlResponse)
@limiter.limit("600/minute")
async def get_presigned_url(request: Request, payload: PresignedUrlRequest, username: str = Depends(get_current_user)):
    try:
        session = upload_sessions_collection.find_one(
            {
                "upload_id": payload.upload_id,
                "user_id": username,
                "status": "in_progress",
                "file_key": payload.file_key,
            },
            {"bucket_id": 1, "bucket_name": 1},
        )
        if not session:
            raise HTTPException(status_code=404, detail="Active upload session not found")

        requested_bucket_id, requested_bucket_name = _normalize_bucket_selector(payload.bucket_id, payload.bucket_name)
        session_bucket_id = (session.get("bucket_id") or "").strip() or None
        session_bucket_name = (session.get("bucket_name") or "").strip() or None

        if requested_bucket_id and requested_bucket_id != session_bucket_id:
            raise HTTPException(status_code=409, detail="Requested bucket does not match upload session bucket")
        if requested_bucket_name and requested_bucket_name != session_bucket_name:
            raise HTTPException(status_code=409, detail="Requested bucket does not match upload session bucket")

        s3_client, bucket_name, _, _, _ = _get_user_bucket_context(
            username,
            bucket_id=session_bucket_id,
            bucket_name=session_bucket_name,
        )
        url = generate_presigned_url(
            payload.file_key,
            payload.upload_id,
            payload.part_number,
            s3_client=s3_client,
            bucket_name=bucket_name,
        )
        return {"url": url, "part_number": payload.part_number}
    except Exception as e:
        _handle_s3_error("Presigned URL", e)


@router.put("/mock-upload-part", include_in_schema=False)
async def mock_upload_part(
    request: Request,
    upload_id: str,
    file_key: str,
    part_number: int = Query(..., ge=1),
):
    if not get_settings().USE_MOCK_S3:
        raise HTTPException(status_code=404, detail="Not found")

    body = await request.body()
    try:
        etag = upload_part_mock(file_key, upload_id, part_number, body)
        return Response(status_code=200, headers={"ETag": etag})
    except Exception as e:
        _handle_s3_error("Mock upload part", e)


@router.post("/complete-upload", response_model=CompleteUploadResponse)
@limiter.limit("30/minute")
async def complete_upload(request: Request, payload: CompleteUploadRequest, username: str = Depends(get_current_user)):
    session = upload_sessions_collection.find_one({
        "file_id": payload.file_id,
        "upload_id": payload.upload_id,
        "file_key": payload.file_key,
        "user_id": username,
        "status": "in_progress",
    })

    if not session:
        raise HTTPException(status_code=404, detail="Active upload session not found")

    requested_bucket_id, requested_bucket_name = _normalize_bucket_selector(payload.bucket_id, payload.bucket_name)
    session_bucket_id = (session.get("bucket_id") or "").strip() or None
    session_bucket_name = (session.get("bucket_name") or "").strip() or None
    if requested_bucket_id and requested_bucket_id != session_bucket_id:
        raise HTTPException(status_code=409, detail="Requested bucket does not match upload session bucket")
    if requested_bucket_name and requested_bucket_name != session_bucket_name:
        raise HTTPException(status_code=409, detail="Requested bucket does not match upload session bucket")

    session_filename = session.get("filename")
    session_size = session.get("size")
    session_checksum = session.get("checksum")
    if session_filename and payload.file_name != session_filename:
        logger.warning(
            "Complete upload filename mismatch for upload_id=%s user=%s payload=%s session=%s",
            payload.upload_id,
            username,
            payload.file_name,
            session_filename,
        )
    if session_size is not None and payload.size != session_size:
        logger.warning(
            "Complete upload size mismatch for upload_id=%s user=%s payload=%s session=%s",
            payload.upload_id,
            username,
            payload.size,
            session_size,
        )
    if session_checksum and payload.checksum != session_checksum:
        logger.warning(
            "Complete upload checksum mismatch for upload_id=%s user=%s payload=%s session=%s",
            payload.upload_id,
            username,
            payload.checksum,
            session_checksum,
        )

    uploaded_part_numbers = _normalize_uploaded_part_numbers(
        session.get("uploaded_part_numbers", []),
        upload_id=payload.upload_id,
        username=username,
    )
    total_parts = int(session.get("total_parts", 0))

    if total_parts <= 0 or len(uploaded_part_numbers) != total_parts:
        raise HTTPException(status_code=400, detail="Upload incomplete")

    payload_part_numbers = sorted({part.PartNumber for part in payload.parts})
    if payload_part_numbers and payload_part_numbers != sorted(uploaded_part_numbers):
        logger.info(
            "Complete upload part list mismatch for upload_id=%s user=%s payload_count=%s session_count=%s",
            payload.upload_id,
            username,
            len(payload_part_numbers),
            len(uploaded_part_numbers),
        )

    session_parts = session.get("parts_uploaded", [])
    etag_by_part_number = {}
    for part in session_parts:
        if not isinstance(part, dict):
            continue

        raw_part_number = part.get("PartNumber")
        etag = part.get("ETag")
        try:
            part_number = int(raw_part_number)
        except (TypeError, ValueError):
            continue

        if part_number < 1 or not etag:
            continue

        etag_by_part_number[part_number] = etag

    ordered_parts = []
    for part_number in sorted(uploaded_part_numbers):
        etag = etag_by_part_number.get(part_number)
        if not etag:
            raise HTTPException(status_code=400, detail="Upload incomplete")
        ordered_parts.append({"PartNumber": part_number, "ETag": etag})

    try:
        s3_client, bucket_name, _, _, _ = _get_user_bucket_context(
            username,
            bucket_id=session_bucket_id,
            bucket_name=session_bucket_name,
        )
        result = complete_multipart_upload(
            payload.file_key,
            payload.upload_id,
            ordered_parts,
            s3_client=s3_client,
            bucket_name=bucket_name,
        )

        final_checksum = payload.checksum or session_checksum
        expected_size = session_size if session_size is not None else payload.size
        actual_size = payload.size
        size_mismatch = expected_size != actual_size
        
        upload_sessions_collection.update_one(
            {"upload_id": payload.upload_id, "user_id": username, "file_id": payload.file_id},
            {
                "$set": {
                    "status": "completed",
                    "checksum": final_checksum,
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                }
            }
        )
        
        # Save record in MongoDB for upload history
        uploads_collection.insert_one({
            "user_id": username,
            "file_id": payload.file_id,
            "file_key": payload.file_key,
            "filename": session_filename or payload.file_name,
            "size": expected_size,
            "checksum": final_checksum,
            "expected_size": expected_size,
            "actual_size": actual_size,
            "size_mismatch": size_mismatch,
            "bucket_id": session_bucket_id,
            "bucket_name": session_bucket_name or bucket_name,
            "bucket": bucket_name,
            "created_at": datetime.now(timezone.utc).isoformat()
        })
        
        return result
    except Exception as e:
        _handle_s3_error("Complete upload", e)


@router.post("/abort", response_model=AbortUploadResponse)
@limiter.limit("60/minute")
async def abort_upload(request: Request, payload: AbortUploadRequest, username: str = Depends(get_current_user)):
    session = upload_sessions_collection.find_one({
        "upload_id": payload.upload_id,
        "file_key": payload.file_key,
        "user_id": username,
        "status": "in_progress",
    })

    if not session:
        raise HTTPException(status_code=404, detail="Active upload session not found")

    requested_bucket_id, requested_bucket_name = _normalize_bucket_selector(payload.bucket_id, payload.bucket_name)
    session_bucket_id = (session.get("bucket_id") or "").strip() or None
    session_bucket_name = (session.get("bucket_name") or "").strip() or None
    if requested_bucket_id and requested_bucket_id != session_bucket_id:
        raise HTTPException(status_code=409, detail="Requested bucket does not match upload session bucket")
    if requested_bucket_name and requested_bucket_name != session_bucket_name:
        raise HTTPException(status_code=409, detail="Requested bucket does not match upload session bucket")

    try:
        s3_client, bucket_name, _, _, _ = _get_user_bucket_context(
            username,
            bucket_id=session_bucket_id,
            bucket_name=session_bucket_name,
        )
        result = abort_multipart_upload(
            payload.file_key,
            payload.upload_id,
            s3_client=s3_client,
            bucket_name=bucket_name,
        )

        upload_sessions_collection.update_one(
            {"upload_id": payload.upload_id, "user_id": username},
            {
                "$set": {
                    "status": "cancelled",
                    "cancelled_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )

        return result
    except Exception as e:
        _handle_s3_error("Abort upload", e)

@router.get("/uploads")
@limiter.limit("120/minute")
async def get_upload_history(
    request: Request,
    username: str = Depends(get_current_user),
    from_ts: str | None = Query(default=None),
    to_ts: str | None = Query(default=None),
):
    uploads_query = {
        "user_id": username,
        "deleted_at": {"$exists": False},
    }

    from_iso = _parse_uploads_query_timestamp(from_ts, "from_ts") if from_ts else None
    to_iso = _parse_uploads_query_timestamp(to_ts, "to_ts") if to_ts else None

    if from_iso and to_iso and from_iso >= to_iso:
        raise HTTPException(status_code=400, detail="from_ts must be earlier than to_ts")

    created_at_filter = {}
    if from_iso:
        created_at_filter["$gte"] = from_iso
    if to_iso:
        created_at_filter["$lt"] = to_iso

    if created_at_filter:
        uploads_query["created_at"] = created_at_filter

    records = list(uploads_collection.find(uploads_query).sort("created_at", -1))
    for r in records:
        r["id"] = str(r["_id"])
        del r["_id"]
    return records


@router.get("/bucket-files", response_model=BucketFileListResponse)
@limiter.limit("120/minute")
async def get_bucket_files(
    request: Request,
    username: str = Depends(get_current_user),
    bucket_id: str | None = Query(default=None),
    bucket_name: str | None = Query(default=None),
):
    normalized_bucket_id, normalized_bucket_name = _normalize_bucket_selector(bucket_id, bucket_name)
    if not normalized_bucket_id and not normalized_bucket_name:
        raise HTTPException(status_code=400, detail="bucket_id or bucket_name is required")

    try:
        if get_settings().USE_MOCK_S3:
            uploads_query = {
                "user_id": username,
                "deleted_at": {"$exists": False},
            }
            if normalized_bucket_name:
                uploads_query["bucket_name"] = normalized_bucket_name

            records = list(uploads_collection.find(uploads_query).sort("created_at", -1))
            files = []
            for record in records:
                file_key = (record.get("file_key") or "").strip()
                if not file_key:
                    continue
                file_name = file_key.rsplit("/", 1)[-1]
                files.append(
                    {
                        "file_key": file_key,
                        "file_name": file_name,
                        "size": int(record.get("size") or 0),
                        "last_modified": record.get("created_at"),
                        "bucket_name": normalized_bucket_name or record.get("bucket_name") or record.get("bucket") or "mock-bucket",
                    }
                )

            return {
                "bucket_name": normalized_bucket_name or "mock-bucket",
                "files": files,
            }

        s3_client, resolved_bucket_name, _, _, _ = _get_user_bucket_context(
            username,
            bucket_id=normalized_bucket_id,
            bucket_name=normalized_bucket_name,
        )

        paginator = s3_client.get_paginator("list_objects_v2")
        files = []
        for page in paginator.paginate(Bucket=resolved_bucket_name):
            for item in page.get("Contents", []):
                file_key = str(item.get("Key") or "").strip()
                if not file_key or file_key.endswith("/"):
                    continue
                files.append(
                    {
                        "file_key": file_key,
                        "file_name": file_key.rsplit("/", 1)[-1],
                        "size": int(item.get("Size") or 0),
                        "last_modified": item.get("LastModified").isoformat() if item.get("LastModified") else None,
                        "bucket_name": resolved_bucket_name,
                    }
                )

        files.sort(key=lambda file: file.get("last_modified") or "", reverse=True)
        return {
            "bucket_name": resolved_bucket_name,
            "files": files,
        }
    except Exception as e:
        _handle_s3_error("List bucket files", e)


@router.post("/get-file-url", response_model=FileUrlResponse)
@limiter.limit("120/minute")
async def get_file_url(request: Request, payload: FileUrlRequest, username: str = Depends(get_current_user)):
    try:
        requested_file_id = (payload.file_id or "").strip() or None
        requested_file_key = (payload.file_key or "").strip() or None
        requested_upload_record_id = (payload.upload_record_id or "").strip() or None
        requested_bucket_id = (payload.bucket_id or "").strip() or None
        requested_bucket_name = (payload.bucket_name or "").strip() or None

        if not requested_file_id and not requested_file_key and not requested_upload_record_id:
            raise HTTPException(status_code=400, detail="file_id, file_key, or upload_record_id is required")

        # Direct bucket-scoped access for file browsing section.
        if requested_file_key and (requested_bucket_id or requested_bucket_name):
            s3_client, resolved_bucket_name, _, _, _ = _get_user_bucket_context(
                username,
                bucket_id=requested_bucket_id,
                bucket_name=requested_bucket_name,
            )
            url = generate_presigned_get_url_with_context(
                requested_file_key,
                s3_client=s3_client,
                bucket_name=resolved_bucket_name,
            )
            return {
                "url": url,
                "file_key": requested_file_key,
                "expires_in": get_settings().PRESIGNED_URL_EXPIRY,
            }

        uploads_query = {
            "user_id": username,
            "deleted_at": {"$exists": False},
        }
        if requested_upload_record_id:
            try:
                uploads_query["_id"] = ObjectId(requested_upload_record_id)
            except (InvalidId, TypeError):
                raise HTTPException(status_code=400, detail="Invalid upload_record_id")
        elif requested_file_key:
            uploads_query["file_key"] = requested_file_key
        elif requested_file_id:
            uploads_query["file_id"] = requested_file_id

        upload_record = uploads_collection.find_one(uploads_query, sort=[("created_at", -1)])
        if not upload_record:
            raise HTTPException(status_code=404, detail="File not found")

        recovered = _recover_upload_record_reference(username, upload_record)

        resolved_file_key = None
        if recovered:
            resolved_file_key = recovered.get("file_key")
        if not resolved_file_key:
            resolved_file_key = (upload_record.get("file_key") or "").strip() or requested_file_key

        if not resolved_file_key:
            raise HTTPException(
                status_code=409,
                detail="This file record predates download support. Re-upload to enable download.",
            )

        bucket_id = None
        bucket_name = None
        if recovered:
            bucket_id = recovered.get("bucket_id")
            bucket_name = recovered.get("bucket_name")

        if not bucket_id:
            bucket_id = (upload_record.get("bucket_id") or "").strip() or None
        if not bucket_name:
            bucket_name = (upload_record.get("bucket_name") or "").strip() or None

        if not bucket_name:
            bucket_name = (upload_record.get("bucket") or "").strip() or None

        if not bucket_id and not bucket_name:
            raise HTTPException(status_code=409, detail="Bucket information missing for this file")

        s3_client, resolved_bucket_name, _, _, _ = _get_user_bucket_context(
            username,
            bucket_id=bucket_id,
            bucket_name=bucket_name,
        )

        url = generate_presigned_get_url_with_context(
            resolved_file_key,
            s3_client=s3_client,
            bucket_name=resolved_bucket_name,
        )

        return {
            "url": url,
            "file_key": resolved_file_key,
            "expires_in": get_settings().PRESIGNED_URL_EXPIRY,
        }
    except Exception as e:
        _handle_s3_error("Get file URL", e)


@router.get("/get-file-url", response_model=FileUrlResponse)
@limiter.limit("120/minute")
async def get_file_url_by_query(
    request: Request,
    username: str = Depends(get_current_user),
    fileId: str | None = Query(default=None),
    file_id: str | None = Query(default=None),
):
    normalized_file_id = (fileId or file_id or "").strip()
    if not normalized_file_id:
        raise HTTPException(status_code=400, detail="fileId or file_id is required")

    payload = FileUrlRequest(file_id=normalized_file_id)
    return await get_file_url(request=request, payload=payload, username=username)


@router.delete("/file/{upload_record_id}", response_model=DeleteFileResponse)
@limiter.limit("60/minute")
async def delete_uploaded_file(
    request: Request,
    upload_record_id: str,
    username: str = Depends(get_current_user),
):
    try:
        try:
            record_object_id = ObjectId(upload_record_id)
        except (InvalidId, TypeError):
            raise HTTPException(status_code=400, detail="Invalid file id")

        upload_record = uploads_collection.find_one(
            {
                "_id": record_object_id,
                "user_id": username,
                "deleted_at": {"$exists": False},
            }
        )
        if not upload_record:
            raise HTTPException(status_code=404, detail="File record not found")

        recovered = _recover_upload_record_reference(username, upload_record)
        file_key = None
        if recovered:
            file_key = (recovered.get("file_key") or "").strip() or None
        if not file_key:
            file_key = (upload_record.get("file_key") or "").strip() or None

        if not file_key:
            raise HTTPException(
                status_code=409,
                detail="Unable to resolve file object key for deletion",
            )

        bucket_id = None
        bucket_name = None
        if recovered:
            bucket_id = (recovered.get("bucket_id") or "").strip() or None
            bucket_name = (recovered.get("bucket_name") or "").strip() or None

        if not bucket_id:
            bucket_id = (upload_record.get("bucket_id") or "").strip() or None
        if not bucket_name:
            bucket_name = (upload_record.get("bucket_name") or "").strip() or None
        if not bucket_name:
            bucket_name = (upload_record.get("bucket") or "").strip() or None

        if not bucket_id and not bucket_name:
            raise HTTPException(status_code=409, detail="Bucket context missing for this file")

        s3_client, resolved_bucket_name, _, _, _ = _get_user_bucket_context(
            username,
            bucket_id=bucket_id,
            bucket_name=bucket_name,
        )

        delete_object_with_context(
            file_key,
            s3_client=s3_client,
            bucket_name=resolved_bucket_name,
        )

        uploads_collection.update_one(
            {"_id": record_object_id, "user_id": username, "deleted_at": {"$exists": False}},
            {
                "$set": {
                    "status": "deleted",
                    "deleted_at": datetime.now(timezone.utc).isoformat(),
                    "deleted_by": username,
                }
            },
        )

        return {
            "message": "File deleted securely",
            "upload_record_id": upload_record_id,
            "file_key": file_key,
        }
    except Exception as e:
        _handle_s3_error("Delete file", e)


@router.post("/file/delete-by-key", response_model=DeleteFileByKeyResponse)
@limiter.limit("60/minute")
async def delete_file_by_key(
    request: Request,
    payload: DeleteFileByKeyRequest,
    username: str = Depends(get_current_user),
):
    try:
        file_key = (payload.file_key or "").strip()
        bucket_id = (payload.bucket_id or "").strip() or None
        bucket_name = (payload.bucket_name or "").strip() or None
        delete_scope = (payload.delete_scope or "object").strip().lower()

        if not file_key:
            raise HTTPException(status_code=400, detail="file_key is required")
        if not bucket_id and not bucket_name:
            raise HTTPException(status_code=400, detail="bucket_id or bucket_name is required")
        if delete_scope not in {"object", "prefix"}:
            raise HTTPException(status_code=400, detail="delete_scope must be object or prefix")

        s3_client, resolved_bucket_name, _, _, _ = _get_user_bucket_context(
            username,
            bucket_id=bucket_id,
            bucket_name=bucket_name,
        )

        deleted_s3_objects = 0
        if delete_scope == "prefix":
            prefix = file_key.rsplit("/", 1)[0] if "/" in file_key else file_key
            normalized_prefix = f"{prefix}/" if prefix and not prefix.endswith("/") else prefix
            if not normalized_prefix:
                raise HTTPException(status_code=400, detail="Cannot infer folder prefix for deletion")

            prefix_delete_result = delete_prefix_with_context(
                normalized_prefix,
                s3_client=s3_client,
                bucket_name=resolved_bucket_name,
            )
            deleted_s3_objects = int(prefix_delete_result.get("deleted_count") or 0)
            mongo_filter = {
                "user_id": username,
                "file_key": {"$regex": f"^{re.escape(normalized_prefix)}"},
                "bucket": resolved_bucket_name,
                "deleted_at": {"$exists": False},
            }
        else:
            delete_object_with_context(
                file_key,
                s3_client=s3_client,
                bucket_name=resolved_bucket_name,
            )
            deleted_s3_objects = 1
            mongo_filter = {
                "user_id": username,
                "file_key": file_key,
                "bucket": resolved_bucket_name,
                "deleted_at": {"$exists": False},
            }

        now_iso = datetime.now(timezone.utc).isoformat()
        update_result = uploads_collection.update_many(
            mongo_filter,
            {
                "$set": {
                    "status": "deleted",
                    "deleted_at": now_iso,
                    "deleted_by": username,
                    "delete_reason": "files_tab_delete",
                }
            },
        )

        return {
            "message": "File deleted securely" if delete_scope == "object" else "Folder path deleted securely",
            "file_key": file_key,
            "deleted_history_records": int(update_result.modified_count or 0),
            "deleted_s3_objects": deleted_s3_objects,
        }
    except Exception as e:
        _handle_s3_error("Delete file by key", e)


@router.delete("/uploads/{upload_record_id}", response_model=DeleteHistoryRecordResponse)
@limiter.limit("90/minute")
async def delete_history_record(
    request: Request,
    upload_record_id: str,
    username: str = Depends(get_current_user),
):
    try:
        try:
            record_object_id = ObjectId(upload_record_id)
        except (InvalidId, TypeError):
            raise HTTPException(status_code=400, detail="Invalid upload record id")

        update_result = uploads_collection.update_one(
            {
                "_id": record_object_id,
                "user_id": username,
                "deleted_at": {"$exists": False},
            },
            {
                "$set": {
                    "status": "history_removed",
                    "deleted_at": datetime.now(timezone.utc).isoformat(),
                    "deleted_by": username,
                    "delete_reason": "history_record_removed",
                }
            },
        )

        if update_result.matched_count == 0:
            raise HTTPException(status_code=404, detail="History record not found")

        return {
            "message": "History record removed",
            "upload_record_id": upload_record_id,
        }
    except Exception as e:
        _handle_s3_error("Delete history record", e)


@router.post("/uploads/clear-history", response_model=ClearHistoryResponse)
@limiter.limit("20/minute")
async def clear_upload_history(
    request: Request,
    username: str = Depends(get_current_user),
):
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        update_result = uploads_collection.update_many(
            {
                "user_id": username,
                "deleted_at": {"$exists": False},
            },
            {
                "$set": {
                    "status": "history_cleared",
                    "deleted_at": now_iso,
                    "deleted_by": username,
                    "delete_reason": "history_cleared",
                }
            },
        )

        return {
            "message": "History cleared successfully",
            "cleared_records": int(update_result.modified_count or 0),
        }
    except Exception as e:
        _handle_s3_error("Clear upload history", e)


@router.post("/add-bucket", response_model=AddBucketResponse)
@limiter.limit("30/minute")
async def add_bucket(request: Request, payload: AddBucketRequest, username: str = Depends(get_current_user)):
    bucket_name = payload.bucket_name.strip()
    resolved_region = payload.region.strip()
    use_kms = bool(payload.use_kms)
    kms_key_id = (payload.kms_key_id or "").strip() or None
    notes = (payload.notes or "").strip()
    validation_status = "verified"
    success_message = "Bucket credentials saved securely"

    def _defer_failed_validation() -> None:
        nonlocal validation_status, success_message
        validation_status = "pending_manual_validation"
        success_message = (
            "Bucket saved, but AWS rejected validation for the provided credentials/bucket. "
            "Update credentials if uploads fail."
        )

    if use_kms and not kms_key_id:
        raise HTTPException(status_code=400, detail="kms_key_id is required when use_kms is enabled")

    if not _is_valid_s3_bucket_name(bucket_name):
        raise HTTPException(
            status_code=400,
            detail="Invalid S3 bucket name. Use 3-63 lowercase letters, numbers, dots, or hyphens.",
        )

    if resolved_region not in _get_available_s3_regions():
        raise HTTPException(
            status_code=400,
            detail=f"Invalid AWS region '{resolved_region}'. Example: ap-south-1",
        )

    try:
        s3 = boto3.client(
            "s3",
            aws_access_key_id=payload.aws_access_key_id,
            aws_secret_access_key=payload.aws_secret_access_key,
            region_name=resolved_region,
        )
        s3.head_bucket(Bucket=bucket_name)
    except ClientError as e:
        detected_region = _extract_bucket_region_from_error(e)
        current_code = str(e.response.get("Error", {}).get("Code", ""))
        current_status = int(e.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0))

        should_retry_with_detected_region = (
            detected_region
            and detected_region != resolved_region
            and (current_code in {"AuthorizationHeaderMalformed", "PermanentRedirect"} or current_status in {301, 400})
        )

        if should_retry_with_detected_region:
            try:
                retry_client = boto3.client(
                    "s3",
                    aws_access_key_id=payload.aws_access_key_id,
                    aws_secret_access_key=payload.aws_secret_access_key,
                    region_name=detected_region,
                )
                retry_client.head_bucket(Bucket=bucket_name)
                resolved_region = detected_region
            except ClientError as retry_error:
                try:
                    _raise_bucket_validation_error(retry_error)
                except HTTPException as validation_error:
                    if validation_error.status_code in {401, 403, 404}:
                        _defer_failed_validation()
                    else:
                        raise
            except (EndpointConnectionError, ConnectTimeoutError, ReadTimeoutError, BotoCoreError):
                resolved_region = detected_region
                validation_status = "pending_network_validation"
                success_message = (
                    "Bucket saved, but AWS connectivity prevented live validation. "
                    f"Detected region '{detected_region}' was stored."
                )
        else:
            try:
                _raise_bucket_validation_error(e)
            except HTTPException as validation_error:
                if validation_error.status_code in {401, 403, 404}:
                    _defer_failed_validation()
                else:
                    raise
    except (EndpointConnectionError, ConnectTimeoutError, ReadTimeoutError, BotoCoreError):
        validation_status = "pending_network_validation"
        success_message = "Bucket saved, but AWS connectivity prevented live validation"

    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        bucket_credentials_collection.update_one(
            {"user_id": username, "bucket_name": bucket_name},
            {
                "$set": {
                    "region": resolved_region,
                    "size_limit": int(payload.size_limit or DEFAULT_BUCKET_SIZE_LIMIT_BYTES),
                    "use_kms": use_kms,
                    "kms_key_id": kms_key_id,
                    "notes": notes,
                    "access_key_encrypted": encrypt_value(payload.aws_access_key_id),
                    "secret_key_encrypted": encrypt_value(payload.aws_secret_access_key),
                    "validation_status": validation_status,
                    "updated_at": now_iso,
                },
                "$setOnInsert": {
                    "user_id": username,
                    "bucket_name": bucket_name,
                    "display_name": bucket_name,
                    "created_at": now_iso,
                },
            },
            upsert=True,
        )

        return {"message": success_message}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Failed to save bucket credentials for user_id=%s", username)
        raise HTTPException(status_code=500, detail="Failed to save bucket credentials") from e


@router.get("/bucket-usage/{bucket_name}", response_model=BucketUsageResponse)
@limiter.limit("120/minute")
async def get_bucket_usage(request: Request, bucket_name: str, username: str = Depends(get_current_user)):
    normalized_bucket_name = (bucket_name or "").strip()
    if not normalized_bucket_name:
        raise HTTPException(status_code=400, detail="bucket_name is required")

    settings = get_settings()

    bucket_record = bucket_credentials_collection.find_one(
        {"user_id": username, "bucket_name": normalized_bucket_name},
        {"size_limit": 1},
    )
    if not bucket_record and normalized_bucket_name != settings.S3_BUCKET_NAME:
        raise HTTPException(status_code=404, detail="Bucket not found")

    if bucket_record:
        size_limit = int(bucket_record.get("size_limit") or DEFAULT_BUCKET_SIZE_LIMIT_BYTES)
    else:
        size_limit = DEFAULT_BUCKET_SIZE_LIMIT_BYTES

    aggregation = list(
        uploads_collection.aggregate(
            [
                {"$match": {"user_id": username, "bucket": normalized_bucket_name}},
                {"$group": {"_id": None, "used": {"$sum": {"$ifNull": ["$size", 0]}}}},
            ]
        )
    )
    used = int(aggregation[0].get("used", 0)) if aggregation else 0

    percent = round((used / size_limit) * 100, 2) if size_limit > 0 else 0.0
    if percent >= 100:
        status = "exceeded"
        message = "Bucket storage limit exceeded"
    elif percent > 80:
        status = "warning"
        message = "Bucket storage usage above 80%"
    else:
        status = "ok"
        message = "Bucket storage usage is within limit"

    return {
        "bucket_name": normalized_bucket_name,
        "used": used,
        "limit": size_limit,
        "percent": percent,
        "status": status,
        "message": message,
    }


@router.get("/buckets", response_model=list[BucketSummary])
@limiter.limit("120/minute")
async def list_buckets(request: Request, username: str = Depends(get_current_user)):
    settings = get_settings()

    records = list(
        bucket_credentials_collection.find({"user_id": username}).sort("created_at", -1)
    )

    sanitized_records = []
    for record in records:
        record_bucket_name = record.get("bucket_name", "")
        sanitized_records.append(
            {
                "id": str(record["_id"]),
                "bucket_name": record_bucket_name,
                "display_name": record.get("display_name") or record_bucket_name,
                "region": record.get("region", ""),
                "size_limit": int(record.get("size_limit") or DEFAULT_BUCKET_SIZE_LIMIT_BYTES),
                "use_kms": bool(record.get("use_kms", False)),
                "kms_key_id": (record.get("kms_key_id") or "").strip() or None,
                "notes": record.get("notes", ""),
                "created_at": record.get("created_at", ""),
                "validation_status": record.get("validation_status", "verified"),
                "system_default": bool(record_bucket_name == settings.S3_BUCKET_NAME),
            }
        )

    has_default_bucket = any(item["bucket_name"] == settings.S3_BUCKET_NAME for item in sanitized_records)
    if settings.S3_BUCKET_NAME and not has_default_bucket:
        sanitized_records.insert(
            0,
            {
                "id": "default-medivault",
                "bucket_name": settings.S3_BUCKET_NAME,
                "display_name": settings.S3_BUCKET_NAME,
                "region": settings.AWS_REGION,
                "size_limit": DEFAULT_BUCKET_SIZE_LIMIT_BYTES,
                "use_kms": False,
                "kms_key_id": None,
                "notes": "",
                "created_at": "",
                "validation_status": "verified",
                "system_default": True,
            },
        )

    return sanitized_records


@router.patch("/buckets/{bucket_id}", response_model=BucketSummary)
@limiter.limit("60/minute")
async def update_bucket(
    request: Request,
    bucket_id: str,
    payload: UpdateBucketRequest,
    username: str = Depends(get_current_user),
):
    if bucket_id == "default-medivault":
        raise HTTPException(status_code=403, detail="MediVault bucket cannot be edited")

    try:
        object_id = ObjectId(bucket_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=400, detail="Invalid bucket id")

    bucket_record = bucket_credentials_collection.find_one({"_id": object_id, "user_id": username})
    if not bucket_record:
        raise HTTPException(status_code=404, detail="Bucket not found")

    updates: dict[str, object] = {"updated_at": datetime.now(timezone.utc).isoformat()}

    if payload.display_name is not None:
        display_name = payload.display_name.strip()
        if not display_name:
            raise HTTPException(status_code=400, detail="display_name cannot be empty")
        updates["display_name"] = display_name

    if payload.notes is not None:
        updates["notes"] = payload.notes.strip()

    existing_use_kms = bool(bucket_record.get("use_kms", False))
    existing_kms_key_id = (bucket_record.get("kms_key_id") or "").strip() or None

    next_use_kms = existing_use_kms if payload.use_kms is None else bool(payload.use_kms)
    next_kms_key_id = existing_kms_key_id

    if payload.kms_key_id is not None:
        parsed_kms_key_id = payload.kms_key_id.strip() or None
        updates["kms_key_id"] = parsed_kms_key_id
        next_kms_key_id = parsed_kms_key_id

    if payload.use_kms is not None:
        updates["use_kms"] = next_use_kms
        if not next_use_kms and payload.kms_key_id is None:
            updates["kms_key_id"] = None
            next_kms_key_id = None

    if next_use_kms and not next_kms_key_id:
        raise HTTPException(status_code=400, detail="kms_key_id is required when use_kms is enabled")

    if payload.size_limit is not None:
        if payload.size_limit <= 0:
            raise HTTPException(status_code=400, detail="size_limit must be greater than 0")
        updates["size_limit"] = int(payload.size_limit)

    if payload.region is not None:
        region = payload.region.strip()
        if not region:
            raise HTTPException(status_code=400, detail="region cannot be empty")
        if region not in _get_available_s3_regions():
            raise HTTPException(status_code=400, detail=f"Invalid AWS region '{region}'")
        updates["region"] = region

    if len(updates) == 1:
        raise HTTPException(status_code=400, detail="No updatable bucket fields provided")

    bucket_credentials_collection.update_one(
        {"_id": object_id, "user_id": username},
        {"$set": updates},
    )

    refreshed = bucket_credentials_collection.find_one({"_id": object_id, "user_id": username})
    if not refreshed:
        raise HTTPException(status_code=404, detail="Bucket not found")

    record_bucket_name = refreshed.get("bucket_name", "")
    return {
        "id": str(refreshed["_id"]),
        "bucket_name": record_bucket_name,
        "display_name": refreshed.get("display_name") or record_bucket_name,
        "region": refreshed.get("region", ""),
        "size_limit": int(refreshed.get("size_limit") or DEFAULT_BUCKET_SIZE_LIMIT_BYTES),
        "use_kms": bool(refreshed.get("use_kms", False)),
        "kms_key_id": (refreshed.get("kms_key_id") or "").strip() or None,
        "notes": refreshed.get("notes", ""),
        "created_at": refreshed.get("created_at", ""),
        "validation_status": refreshed.get("validation_status", "verified"),
        "system_default": bool(record_bucket_name == get_settings().S3_BUCKET_NAME),
    }


@router.delete("/buckets/{bucket_id}", response_model=DeleteBucketResponse)
@limiter.limit("60/minute")
async def delete_bucket(request: Request, bucket_id: str, username: str = Depends(get_current_user)):
    if bucket_id == "default-medivault":
        raise HTTPException(status_code=403, detail="MediVault bucket cannot be deleted")

    try:
        object_id = ObjectId(bucket_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=400, detail="Invalid bucket id")

    bucket_record = bucket_credentials_collection.find_one({"_id": object_id, "user_id": username})
    if not bucket_record:
        raise HTTPException(status_code=404, detail="Bucket not found")

    if bucket_record.get("bucket_name") == get_settings().S3_BUCKET_NAME:
        raise HTTPException(status_code=403, detail="MediVault bucket cannot be deleted")

    bucket_name = bucket_record.get("bucket_name")
    active_session = upload_sessions_collection.find_one(
        {
            "user_id": username,
            "bucket_name": bucket_name,
            "status": "in_progress",
        },
        {"_id": 1},
    )
    if active_session:
        raise HTTPException(status_code=409, detail="Cannot delete bucket while uploads are in progress")

    delete_result = bucket_credentials_collection.delete_one({"_id": object_id, "user_id": username})
    if delete_result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Bucket not found")

    return {"message": "Bucket deleted successfully"}
