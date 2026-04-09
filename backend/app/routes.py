import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Depends, Request, Response, Query
from botocore.exceptions import ClientError, BotoCoreError
from app.schemas import (
    StartUploadRequest, StartUploadResponse,
    PresignedUrlRequest, PresignedUrlResponse,
    CompleteUploadRequest, CompleteUploadResponse,
    AbortUploadRequest, AbortUploadResponse,
    FileUrlRequest, FileUrlResponse,
    UpdatePartRequest, UpdatePartResponse,
    ResumeSessionResponse
)
from app.s3_client import (
    initiate_multipart_upload,
    generate_presigned_url,
    complete_multipart_upload,
    abort_multipart_upload,
    generate_presigned_get_url,
    upload_part_mock,
)
from app.auth import get_current_user
from app.database import upload_sessions_collection, uploads_collection
from app.config import get_settings
from app.rate_limit import limiter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/upload", tags=["Upload"])
CHUNK_SIZE_BYTES = 5 * 1024 * 1024


def _calculate_total_parts(file_size: int) -> int:
    if file_size <= 0:
        return 0
    return (file_size + CHUNK_SIZE_BYTES - 1) // CHUNK_SIZE_BYTES


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
        }
        unauthorized_codes = {"AccessDenied", "SignatureDoesNotMatch", "InvalidAccessKeyId"}

        if code in bad_request_codes:
            raise HTTPException(status_code=400, detail=f"Bad upload request: {msg}")
        if code in unauthorized_codes:
            raise HTTPException(status_code=401, detail="Unauthorized to perform upload operation")

        raise HTTPException(status_code=502, detail=f"S3 {code}: {msg}")

    if isinstance(e, BotoCoreError):
        logger.exception("%s failed with AWS SDK transport error", action)
        raise HTTPException(status_code=502, detail=f"AWS error: {str(e)}")

    logger.exception("%s failed unexpectedly", action)
    raise HTTPException(status_code=500, detail=f"{action} failed: {str(e)}")


@router.post("/start-upload", response_model=StartUploadResponse)
@limiter.limit("30/minute")
async def start_upload(request: Request, payload: StartUploadRequest, username: str = Depends(get_current_user)):
    try:
        result = initiate_multipart_upload(payload.file_name, payload.content_type, username)
        total_parts = _calculate_total_parts(payload.size)
        
        upload_sessions_collection.insert_one({
            "user_id": username,
            "file_id": payload.file_id,
            "filename": payload.file_name,
            "size": payload.size,
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
        url = generate_presigned_url(payload.file_key, payload.upload_id, payload.part_number)
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
        result = complete_multipart_upload(payload.file_key, payload.upload_id, ordered_parts)
        
        upload_sessions_collection.update_one(
            {"upload_id": payload.upload_id, "user_id": username, "file_id": payload.file_id},
            {"$set": {"status": "completed", "completed_at": datetime.now(timezone.utc).isoformat()}}
        )
        
        # Save record in MongoDB for upload history
        uploads_collection.insert_one({
            "user_id": username,
            "filename": session_filename or payload.file_name,
            "size": session_size if session_size is not None else payload.size,
            "bucket": get_settings().S3_BUCKET_NAME,
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
        result = abort_multipart_upload(payload.file_key, payload.upload_id)

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
async def get_upload_history(request: Request, username: str = Depends(get_current_user)):
    records = list(uploads_collection.find({"user_id": username}).sort("created_at", -1))
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
