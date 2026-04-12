# Architecture

## 1. Overview

MediVault is a two-tier application:

- Frontend: React + Vite client for authentication, bucket management, upload control, and analytics.
- Backend: FastAPI service handling auth, multipart upload orchestration, bucket credential vault, and history APIs.

Persistent state is stored in MongoDB, while binary payload data is stored in S3-compatible object storage.

## 2. Component Map

```mermaid
flowchart TB
  subgraph Client
    UI[React UI]
    Hook[useChunkedUpload Hook]
  end

  subgraph API
    Auth[Auth Routes]
    Upload[Upload Routes]
    Clean[Cleanup Loop]
  end

  subgraph Data
    Mongo[(MongoDB)]
    S3[(AWS S3 or Mock S3)]
  end

  UI --> Hook
  Hook --> Upload
  UI --> Auth
  Auth --> Mongo
  Upload --> Mongo
  Upload --> S3
  Clean --> Mongo
  Clean --> S3
```

## 3. Runtime Responsibilities

### Frontend

- Validates file type by magic bytes before upload.
- Splits files into multipart chunks.
- Requests pre-signed URLs per part.
- Uploads parts in parallel with retry/backoff.
- Tracks progress, status, ETA, and adaptive telemetry.
- Stores auth token in session storage.

### Backend

- Issues and validates JWT access tokens.
- Stores encrypted bucket credentials by user.
- Starts/resumes/completes/aborts multipart uploads.
- Enforces bucket-session consistency across upload operations.
- Records upload history and bucket usage metrics.
- Cleans up expired unfinished upload sessions.

## 4. Upload Lifecycle

```mermaid
sequenceDiagram
  participant U as User
  participant FE as Frontend
  participant BE as Backend
  participant DB as MongoDB
  participant S3 as S3

  U->>FE: Select file + bucket
  FE->>FE: Validate file type (magic bytes)
  FE->>BE: GET /resume-session
  BE->>DB: Find in-progress session by user/file/bucket
  DB-->>BE: Session or none
  BE-->>FE: Resume metadata

  alt Session exists
    FE->>BE: POST /presigned-url (per part)
  else No session
    FE->>BE: POST /start-upload
    BE->>S3: create_multipart_upload
    S3-->>BE: upload_id + file_key
    BE->>DB: Save upload session
    BE-->>FE: upload_id + file_key
  end

  loop For each remaining chunk
    FE->>BE: POST /presigned-url
    BE-->>FE: Signed PUT URL
    FE->>S3: PUT chunk
    S3-->>FE: ETag
    FE->>BE: POST /update-part
    BE->>DB: Persist part info
  end

  FE->>BE: POST /complete-upload
  BE->>S3: complete_multipart_upload
  BE->>DB: Mark session complete + save history record
  BE-->>FE: Upload completed
```

## 5. Upload Session State Model

```mermaid
stateDiagram-v2
  [*] --> in_progress
  in_progress --> paused: client pause
  paused --> in_progress: client resume
  in_progress --> completed: complete-upload success
  in_progress --> cancelled: abort
  in_progress --> expired: cleanup loop
  expired --> cleanup_failed: abort failure during cleanup
  cleanup_failed --> expired: later cleanup success
  completed --> [*]
  cancelled --> [*]
```

## 6. Bucket Context Strategy

- Bucket is selected by user in UI before upload actions.
- Backend resolves bucket credentials from MongoDB per user.
- Session binds bucket_id and bucket_name at start.
- Later presign, complete, and abort requests validate bucket match.

## 7. Security-Critical Boundaries

- Credentials are encrypted before persistence.
- JWT protects all non-auth upload and bucket routes.
- Rate limiting is applied to auth and upload APIs.
- Secrets are not returned to frontend.

## 8. Operational Services

- Startup checks MongoDB connectivity and required indexes.
- Periodic cleanup task scans expired in-progress sessions.
- Health endpoint exposes backend liveness.
