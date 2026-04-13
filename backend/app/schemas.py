from pydantic import BaseModel, Field
from typing import List

# ── Start Upload ──────────────────────────────────────────────
class StartUploadRequest(BaseModel):
    file_id: str = Field(..., min_length=1, max_length=512)
    file_name: str = Field(..., min_length=1, max_length=255)
    content_type: str = Field(default="application/octet-stream", min_length=1, max_length=255)
    size: int = Field(default=0, ge=0)
    checksum: str = Field(..., min_length=1, max_length=128)
    bucket_id: str | None = Field(default=None, min_length=1, max_length=64)
    bucket_name: str | None = Field(default=None, min_length=1, max_length=255)

class StartUploadResponse(BaseModel):
    upload_id: str
    file_key: str

# ── Pre-signed URL ────────────────────────────────────────────
class PresignedUrlRequest(BaseModel):
    file_key: str = Field(..., min_length=1, max_length=1024)
    upload_id: str = Field(..., min_length=1, max_length=512)
    part_number: int = Field(..., ge=1)
    bucket_id: str | None = Field(default=None, min_length=1, max_length=64)
    bucket_name: str | None = Field(default=None, min_length=1, max_length=255)

class PresignedUrlResponse(BaseModel):
    url: str
    part_number: int

# ── Session Management ─────────────────────────────────────────
class UpdatePartRequest(BaseModel):
    file_id: str = Field(..., min_length=1, max_length=512)
    file_key: str = Field(..., min_length=1, max_length=1024)
    upload_id: str = Field(..., min_length=1, max_length=512)
    part_number: int = Field(..., ge=1)
    etag: str = Field(..., min_length=1, max_length=256)

class UpdatePartResponse(BaseModel):
    message: str

class UploadPart(BaseModel):
    ETag: str = Field(..., min_length=1, max_length=256)
    PartNumber: int = Field(..., ge=1)

class ResumeSessionResponse(BaseModel):
    has_session: bool = False
    upload_id: str | None = None
    file_key: str | None = None
    bucket_id: str | None = None
    bucket_name: str | None = None
    uploaded_part_numbers: List[int] = Field(default_factory=list)
    total_parts: int = Field(default=0, ge=0)

# ── Complete Upload ───────────────────────────────────────────
class CompleteUploadRequest(BaseModel):
    file_id: str = Field(..., min_length=1, max_length=512)
    file_key: str = Field(..., min_length=1, max_length=1024)
    upload_id: str = Field(..., min_length=1, max_length=512)
    file_name: str = Field(..., min_length=1, max_length=255)
    size: int = Field(..., ge=0)
    checksum: str = Field(..., min_length=1, max_length=128)
    bucket_id: str | None = Field(default=None, min_length=1, max_length=64)
    bucket_name: str | None = Field(default=None, min_length=1, max_length=255)
    parts: List[UploadPart] = Field(default_factory=list)

class CompleteUploadResponse(BaseModel):
    message: str
    location: str

# ── Abort Upload ──────────────────────────────────────────────
class AbortUploadRequest(BaseModel):
    file_key: str = Field(..., min_length=1, max_length=1024)
    upload_id: str = Field(..., min_length=1, max_length=512)
    bucket_id: str | None = Field(default=None, min_length=1, max_length=64)
    bucket_name: str | None = Field(default=None, min_length=1, max_length=255)

class AbortUploadResponse(BaseModel):
    message: str

# ── File Preview URL ──────────────────────────────────────────
class FileUrlRequest(BaseModel):
    file_key: str | None = Field(default=None, min_length=1, max_length=1024)
    file_id: str | None = Field(default=None, min_length=1, max_length=512)
    upload_record_id: str | None = Field(default=None, min_length=1, max_length=64)
    bucket_id: str | None = Field(default=None, min_length=1, max_length=64)
    bucket_name: str | None = Field(default=None, min_length=1, max_length=255)

class FileUrlResponse(BaseModel):
    url: str
    file_key: str
    expires_in: int = Field(default=3600, ge=1)


class DeleteFileResponse(BaseModel):
    message: str
    upload_record_id: str
    file_key: str


class DeleteFileByKeyRequest(BaseModel):
    file_key: str = Field(..., min_length=1, max_length=1024)
    bucket_id: str | None = Field(default=None, min_length=1, max_length=64)
    bucket_name: str | None = Field(default=None, min_length=1, max_length=255)
    delete_scope: str = Field(default="object", pattern="^(object|prefix)$")


class DeleteFileByKeyResponse(BaseModel):
    message: str
    file_key: str
    deleted_history_records: int = Field(default=0, ge=0)
    deleted_s3_objects: int = Field(default=0, ge=0)


class DeleteHistoryRecordResponse(BaseModel):
    message: str
    upload_record_id: str


class ClearHistoryResponse(BaseModel):
    message: str
    cleared_records: int = Field(default=0, ge=0)


class BucketFileSummary(BaseModel):
    file_key: str
    file_name: str
    size: int = Field(default=0, ge=0)
    last_modified: str | None = None
    bucket_name: str


class BucketFileListResponse(BaseModel):
    bucket_name: str
    files: List[BucketFileSummary] = Field(default_factory=list)


# ── Bucket Credentials ───────────────────────────────────────
class AddBucketRequest(BaseModel):
    aws_access_key_id: str = Field(..., min_length=1, max_length=128)
    aws_secret_access_key: str = Field(..., min_length=1, max_length=256)
    region: str = Field(..., min_length=1, max_length=64)
    bucket_name: str = Field(..., min_length=1, max_length=255)
    size_limit: int = Field(default=10737418240, ge=1)
    use_kms: bool = Field(default=False)
    kms_key_id: str | None = Field(default=None, min_length=1, max_length=512)
    notes: str | None = Field(default=None, max_length=2000)


class AddBucketResponse(BaseModel):
    message: str


class BucketSummary(BaseModel):
    id: str
    bucket_name: str
    display_name: str | None = None
    region: str
    size_limit: int
    use_kms: bool = False
    kms_key_id: str | None = None
    notes: str | None = None
    created_at: str
    validation_status: str | None = None
    system_default: bool = False


class UpdateBucketRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    region: str | None = Field(default=None, min_length=1, max_length=64)
    size_limit: int | None = Field(default=None, ge=1)
    use_kms: bool | None = None
    kms_key_id: str | None = Field(default=None, max_length=512)
    notes: str | None = Field(default=None, max_length=2000)


class DeleteBucketResponse(BaseModel):
    message: str


class BucketUsageResponse(BaseModel):
    bucket_name: str
    used: int
    limit: int
    percent: float
    status: str
    message: str
