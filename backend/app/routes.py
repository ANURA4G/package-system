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
    UpdatePartRequest, UpdatePartResponse,
    ResumeSessionResponse,
    AddBucketRequest, AddBucketResponse,
    BucketSummary,
    DeleteBucketResponse,
    BucketUsageResponse,
)
from app.s3_client import (
    create_s3_client,
    initiate_multipart_upload,
    generate_presigned_url,
    complete_multipart_upload,
    abort_multipart_upload,
    generate_presigned_get_url,
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
            raise HTTPException(status_code=403, detail="Forbidden to perform upload operation")
        if code in unauthorized_codes:
            raise HTTPException(status_code=401, detail="Unauthorized to perform upload operation")

        raise HTTPException(status_code=502, detail=f"S3 {code}: {msg}")

    if isinstance(e, BotoCoreError):
        logger.exception("%s failed with AWS SDK transport error", action)
        raise HTTPException(status_code=502, detail=f"AWS error: {str(e)}")

    logger.exception("%s failed unexpectedly", action)
    raise HTTPException(status_code=500, detail=f"{action} failed: {str(e)}")


def _get_user_bucket_context(
    username: str,
    preferred_bucket: str | None = None,
    strict_preferred: bool = False,
):
    settings = get_settings()

    if settings.USE_MOCK_S3:
        return None, settings.S3_BUCKET_NAME

    # Allow selecting the built-in MediVault bucket from UI without requiring saved user credentials.
    if preferred_bucket and preferred_bucket == settings.S3_BUCKET_NAME:
        return None, settings.S3_BUCKET_NAME

    query = {"user_id": username}
    if preferred_bucket:
        query["bucket_name"] = preferred_bucket

    bucket_record = bucket_credentials_collection.find_one(query, sort=[("created_at", -1)])
    if not bucket_record:
        if preferred_bucket and strict_preferred:
            raise HTTPException(status_code=404, detail=f"Selected bucket '{preferred_bucket}' not found")
        return None, settings.S3_BUCKET_NAME

    try:
        access_key = decrypt_value(bucket_record["access_key_encrypted"])
        secret_key = decrypt_value(bucket_record["secret_key_encrypted"])
    except ValueError as e:
        raise HTTPException(status_code=500, detail="Stored bucket credentials are invalid") from e

    bucket_name = bucket_record["bucket_name"]
    configured_region = (bucket_record.get("region") or "").strip()

    if not _is_valid_s3_bucket_name(bucket_name):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Saved bucket name '{bucket_name}' is invalid. "
                "Delete it and add a valid S3 bucket name."
            ),
        )

    available_regions = _get_available_s3_regions()
    if configured_region not in available_regions:
        detected_region = _discover_bucket_region(access_key, secret_key, bucket_name)
        if not detected_region:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Invalid AWS region '{configured_region}' for bucket '{bucket_name}'. "
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
    return client, bucket_record["bucket_name"]


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

        preferred_bucket = (payload.bucket_name or "").strip() or None
        s3_client, bucket_name = _get_user_bucket_context(
            username,
            preferred_bucket=preferred_bucket,
            strict_preferred=bool(preferred_bucket),
        )
        result = initiate_multipart_upload(
            payload.file_name,
            payload.content_type,
            username,
            s3_client=s3_client,
            bucket_name=bucket_name,
        )
        total_parts = _calculate_total_parts(payload.size)
        
        upload_sessions_collection.insert_one({
            "user_id": username,
            "file_id": payload.file_id,
            "filename": payload.file_name,
            "bucket_name": bucket_name,
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
            "Started upload session user_id=%s file_id=%s upload_id=%s total_parts=%s",
            username,
            payload.file_id,
            result["upload_id"],
            total_parts,
        )
        
        return result
    except Exception as e:
        _handle_s3_error("Start upload", e)


@router.get("/resume-session", response_model=ResumeSessionResponse)
@limiter.limit("120/minute")
async def resume_session(request: Request, file_id: str, username: str = Depends(get_current_user)):
    logger.info("Resume session requested user_id=%s file_id=%s", username, file_id)

    try:
        session = upload_sessions_collection.find_one({
            "user_id": username,
            "file_id": file_id,
            "status": "in_progress",
        })
    except Exception as e:
        logger.exception("Resume session query failed user_id=%s file_id=%s", username, file_id)
        raise HTTPException(status_code=500, detail="Failed to fetch upload session") from e

    if not session:
        logger.info("No active session found user_id=%s file_id=%s", username, file_id)
        return {
            "has_session": False,
            "upload_id": None,
            "file_key": None,
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
            {"upload_id": payload.upload_id, "user_id": username},
            {"bucket_name": 1},
        )
        preferred_bucket = session.get("bucket_name") if session else None
        s3_client, bucket_name = _get_user_bucket_context(username, preferred_bucket)
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
        s3_client, bucket_name = _get_user_bucket_context(username, session.get("bucket_name"))
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
            "filename": session_filename or payload.file_name,
            "size": expected_size,
            "checksum": final_checksum,
            "expected_size": expected_size,
            "actual_size": actual_size,
            "size_mismatch": size_mismatch,
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

    try:
        s3_client, bucket_name = _get_user_bucket_context(username, session.get("bucket_name"))
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
    uploads_query = {"user_id": username}

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


@router.post("/get-file-url", response_model=FileUrlResponse)
@limiter.limit("120/minute")
async def get_file_url(request: Request, payload: FileUrlRequest, username: str = Depends(get_current_user)):
    try:
        url = generate_presigned_get_url(payload.file_key)
        return {"url": url, "file_key": payload.file_key}
    except Exception as e:
        _handle_s3_error("Get file URL", e)


@router.post("/add-bucket", response_model=AddBucketResponse)
@limiter.limit("30/minute")
async def add_bucket(request: Request, payload: AddBucketRequest, username: str = Depends(get_current_user)):
    bucket_name = payload.bucket_name.strip()
    resolved_region = payload.region.strip()
    validation_status = "verified"
    success_message = "Bucket credentials saved securely"

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
                _raise_bucket_validation_error(retry_error)
            except (EndpointConnectionError, ConnectTimeoutError, ReadTimeoutError, BotoCoreError):
                resolved_region = detected_region
                validation_status = "pending_network_validation"
                success_message = (
                    "Bucket saved, but AWS connectivity prevented live validation. "
                    f"Detected region '{detected_region}' was stored."
                )
        else:
            _raise_bucket_validation_error(e)
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
                    "access_key_encrypted": encrypt_value(payload.aws_access_key_id),
                    "secret_key_encrypted": encrypt_value(payload.aws_secret_access_key),
                    "validation_status": validation_status,
                    "updated_at": now_iso,
                },
                "$setOnInsert": {
                    "user_id": username,
                    "bucket_name": bucket_name,
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
                "region": record.get("region", ""),
                "size_limit": int(record.get("size_limit") or DEFAULT_BUCKET_SIZE_LIMIT_BYTES),
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
                "region": settings.AWS_REGION,
                "size_limit": DEFAULT_BUCKET_SIZE_LIMIT_BYTES,
                "created_at": "",
                "validation_status": "verified",
                "system_default": True,
            },
        )

    return sanitized_records


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
