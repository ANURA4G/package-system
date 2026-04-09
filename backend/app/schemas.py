from pydantic import BaseModel, Field
from typing import List

# ── Start Upload ──────────────────────────────────────────────
class StartUploadRequest(BaseModel):
    file_id: str = Field(..., min_length=1, max_length=512)
    file_name: str = Field(..., min_length=1, max_length=255)
    content_type: str = Field(default="application/octet-stream", min_length=1, max_length=255)
    size: int = Field(default=0, ge=0)

class StartUploadResponse(BaseModel):
    upload_id: str
    file_key: str

# ── Pre-signed URL ────────────────────────────────────────────
class PresignedUrlRequest(BaseModel):
    file_key: str = Field(..., min_length=1, max_length=1024)
    upload_id: str = Field(..., min_length=1, max_length=512)
    part_number: int = Field(..., ge=1)

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
    uploaded_part_numbers: List[int] = Field(default_factory=list)
    total_parts: int = Field(default=0, ge=0)

# ── Complete Upload ───────────────────────────────────────────
class CompleteUploadRequest(BaseModel):
    file_id: str = Field(..., min_length=1, max_length=512)
    file_key: str = Field(..., min_length=1, max_length=1024)
    upload_id: str = Field(..., min_length=1, max_length=512)
    file_name: str = Field(..., min_length=1, max_length=255)
    size: int = Field(..., ge=0)
    parts: List[UploadPart] = Field(default_factory=list)

class CompleteUploadResponse(BaseModel):
    message: str
    location: str

# ── Abort Upload ──────────────────────────────────────────────
class AbortUploadRequest(BaseModel):
    file_key: str = Field(..., min_length=1, max_length=1024)
    upload_id: str = Field(..., min_length=1, max_length=512)

class AbortUploadResponse(BaseModel):
    message: str

# ── File Preview URL ──────────────────────────────────────────
class FileUrlRequest(BaseModel):
    file_key: str = Field(..., min_length=1, max_length=1024)

class FileUrlResponse(BaseModel):
    url: str
    file_key: str
