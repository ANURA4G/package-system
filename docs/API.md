# API Reference

Base URL in local development:

- http://127.0.0.1:8000/api

Auth model:

- Bearer JWT in Authorization header for protected routes.

```http
Authorization: Bearer <access_token>
```

## 1. Authentication Endpoints

### POST /auth/register

Creates a user account.

Request body:

```json
{
  "username": "clinician1",
  "password": "strong-password"
}
```

Responses:

- 200: registration success
- 400: username already exists
- 429: rate limit exceeded

### POST /auth/login

Authenticates user and returns access token. Also sets an HttpOnly `refresh_token` cookie for silent renewal.

Request body:

```json
{
  "username": "clinician1",
  "password": "strong-password"
}
```

Response body:

```json
{
  "access_token": "<jwt>",
  "token_type": "bearer",
  "expires_in": 3600
}
```

### POST /auth/refresh

Silently renews the access token using the HttpOnly refresh cookie. Rotates the refresh token on each call.

Response body:

```json
{
  "access_token": "<new-jwt>",
  "token_type": "bearer",
  "expires_in": 3600
}
```

Responses:

- 200: new access token issued
- 401: refresh token missing, expired, or revoked

### POST /auth/logout

Revokes the current refresh token and clears the cookie.

Response body:

```json
{
  "message": "Logged out successfully"
}
```

### GET /auth/me

Returns authenticated username.

Response body:

```json
{
  "username": "clinician1"
}
```

## 2. Upload Lifecycle Endpoints

All endpoints below require authentication.

### POST /upload/start-upload

Starts multipart upload session.

Request body:

```json
{
  "file_id": "name-size",
  "file_name": "scan.dcm",
  "content_type": "application/octet-stream",
  "size": 52428800,
  "checksum": "pending",
  "bucket_name": "my-bucket"
}
```

Response body:

```json
{
  "upload_id": "...",
  "file_key": "medical-uploads/user/yyyy/mm/dd/..."
}
```

Notes:

- Bucket selection is required by current route behavior.
- Allowed extensions are validated server-side.

### GET /upload/resume-session

Returns existing in-progress session for file and selected bucket.

Query params:

- file_id (required)
- bucket_name (optional in contract, expected in current flow)
- bucket_id (optional)

Response when found:

```json
{
  "has_session": true,
  "upload_id": "...",
  "file_key": "...",
  "bucket_id": "...",
  "bucket_name": "my-bucket",
  "uploaded_part_numbers": [1, 2, 3],
  "total_parts": 20
}
```

Response when not found:

```json
{
  "has_session": false,
  "upload_id": null,
  "file_key": null,
  "bucket_id": null,
  "bucket_name": null,
  "uploaded_part_numbers": [],
  "total_parts": 0
}
```

### POST /upload/presigned-url

Gets signed URL for one part upload.

Request body:

```json
{
  "file_key": "...",
  "upload_id": "...",
  "part_number": 4,
  "bucket_name": "my-bucket"
}
```

Response body:

```json
{
  "url": "https://...",
  "part_number": 4
}
```

### POST /upload/update-part

Records uploaded part metadata.

Request body:

```json
{
  "file_id": "name-size",
  "file_key": "...",
  "upload_id": "...",
  "part_number": 4,
  "etag": "\"etag-value\""
}
```

Response:

```json
{
  "message": "Part updated"
}
```

### POST /upload/complete-upload

Finalizes multipart upload and writes history record.

Request body:

```json
{
  "file_id": "name-size",
  "file_key": "...",
  "upload_id": "...",
  "file_name": "scan.dcm",
  "size": 52428800,
  "checksum": "sha256...",
  "bucket_name": "my-bucket",
  "parts": [
    { "PartNumber": 1, "ETag": "\"...\"" }
  ]
}
```

Response body:

```json
{
  "message": "Upload completed successfully",
  "location": "..."
}
```

### POST /upload/abort

Aborts in-progress multipart upload.

Request body:

```json
{
  "file_key": "...",
  "upload_id": "...",
  "bucket_name": "my-bucket"
}
```

Response body:

```json
{
  "message": "Upload aborted successfully"
}
```

## 3. Upload Records and File Access

### GET /upload/uploads

Returns upload history for current user.

Optional query params:

- from_ts (ISO timestamp)
- to_ts (ISO timestamp)

### POST /upload/get-file-url

Returns pre-signed GET URL for file key.

Request body:

```json
{
  "file_key": "medical-uploads/..."
}
```

## 4. Bucket Management Endpoints

### POST /upload/add-bucket

Validates and stores bucket credentials.

Request body:

```json
{
  "aws_access_key_id": "AKIA...",
  "aws_secret_access_key": "...",
  "region": "ap-south-1",
  "bucket_name": "my-bucket",
  "size_limit": 10737418240,
  "use_kms": false,
  "kms_key_id": null,
  "notes": "optional"
}
```

Response:

```json
{
  "message": "Bucket credentials saved securely"
}
```

Possible deferred messages:

- pending_network_validation
- pending_manual_validation

### GET /upload/buckets

Returns list of saved bucket configurations.

### PATCH /upload/buckets/{bucket_id}

Updates bucket metadata.

Updatable fields:

- display_name
- region
- size_limit
- use_kms
- kms_key_id
- notes

### DELETE /upload/buckets/{bucket_id}

Deletes saved bucket config if no in-progress session exists.

### GET /upload/bucket-usage/{bucket_name}

Returns used bytes, limit, and usage status.

## 5. Error Model

Common status patterns:

- 400: validation or malformed request
- 401: invalid or expired auth / AWS credential issue in specific flows
- 403: forbidden action
- 404: not found
- 409: conflict (for example bucket/session mismatch)
- 415: unsupported file type extension
- 429: rate limit exceeded
- 500/502: internal or upstream service error
