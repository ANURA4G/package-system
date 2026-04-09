# MediVault Backend

FastAPI backend for authenticated multipart upload orchestration to AWS S3.

## Current Demo Scope

- User registration and login with JWT access tokens.
- Multipart upload lifecycle APIs:
  - start-upload
  - presigned-url
  - update-part
  - complete-upload
  - abort
  - resume-session
- Upload history persistence in MongoDB.
- Security hardening with JWT secret validation, env-driven CORS, and route rate limits.

## Future Scope

- AI/ML upload anomaly detection and predictive retry tuning.
- Cloud DICOM preview generation and retrieval APIs.
- Expanded compliance controls and audit reporting workflows.

## Tech Stack

- FastAPI
- MongoDB (pymongo)
- AWS S3 (boto3 multipart + pre-signed URLs)
- JWT auth (pyjwt + bcrypt)
- Rate limiting (slowapi)

## Prerequisites

- Python 3.10+
- MongoDB instance
- AWS S3 bucket and IAM credentials with multipart upload permissions

## Setup

1. Create and activate a virtual environment.
2. Install dependencies:

   pip install -r requirements.txt

3. Copy environment template:

   Copy .env.example to .env and fill values.

## Required Environment Variables

- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- AWS_REGION
- S3_BUCKET_NAME
- MONGO_URI
- MONGO_DB_NAME
- JWT_SECRET_KEY (must be strong, minimum 32 chars)

## Optional Environment Variables

- PRESIGNED_URL_EXPIRY (default 3600)
- ACCESS_TOKEN_EXPIRE_MINUTES (60 to 1440)
- CORS_ALLOW_ORIGINS (comma-separated list)
- UPLOAD_CLEANUP_INTERVAL_SECONDS (default 300)

## Run Locally

Start API from backend directory:

uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

On startup, the API logs MongoDB connectivity, for example:

MongoDB connection successful target=localhost:27017 database=medivault

Health endpoint:

GET /health

## Docker MongoDB (Optional)

If you run MongoDB with Docker, use a named volume so data persists after container/backend restarts:

docker compose up -d mongo

This repository includes a compose file with:

- Mongo service on port 27017
- Named volume mounted to /data/db

## Multipart Upload Cleanup

Automatic backend cleanup is enabled for expired upload sessions:

- Upload sessions expire 24 hours after creation.
- A periodic background cleanup task aborts expired in-progress multipart uploads in S3.
- Failed cleanup attempts are marked and retried by the periodic task.

### S3 Lifecycle Rule (Recommended Safety Net)

Configure an S3 lifecycle rule on the upload bucket:

- Rule type: Abort incomplete multipart uploads
- Days after initiation: 1 or 2

This provides automatic cleanup even if backend cleanup is temporarily unavailable.

Example AWS CLI command:

aws s3api put-bucket-lifecycle-configuration --bucket YOUR_BUCKET_NAME --lifecycle-configuration "{\"Rules\":[{\"ID\":\"AbortIncompleteMultipartUploads\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"medical-uploads/\"},\"AbortIncompleteMultipartUpload\":{\"DaysAfterInitiation\":2}}]}"

## No-AWS Mock Validation

Run full mock end-to-end validation (no real AWS calls):

1. Set `USE_MOCK_S3=true` in environment (or inline for the command).
2. Execute:

   python validate_mock_e2e.py

This validates normal upload, pause/resume, crash recovery, retry handling, and cancel flow against a local mock storage layer.

## API Prefixes

- /api/auth
- /api/upload

## Security Notes

- JWT secret is required from env; weak placeholder values are rejected.
- CORS allowed origins are env-driven.
- Rate limiting is enabled for auth and upload endpoints.
- See SECURITY.md for full details.

## Upload Contract (Current)

- start-upload request includes file_name, content_type, size.
- complete-upload request includes file_key, upload_id, file_name, size, parts.
- backend validates session ownership and stores trusted metadata in history.
