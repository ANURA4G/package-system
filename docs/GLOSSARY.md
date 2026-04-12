# Glossary

## Access Token

A JWT returned by login and sent as Bearer token for protected API calls.

## Bucket Context

The selected storage bucket identity used for upload operations. In MediVault, this is resolved from user-owned bucket records.

## Bucket Validation Status

Represents backend validation result for a saved bucket configuration.

Common values:

- verified
- pending_network_validation
- pending_manual_validation

## Checksum

SHA-256 hash used to represent file integrity metadata.

## Chunk

A file slice uploaded as one multipart part (minimum effective size around 5 MB for S3 multipart flow).

## ETag

Identifier returned after uploading a multipart chunk; required to complete multipart uploads.

## Multipart Upload

S3 upload mechanism where one file is uploaded in multiple parts and finalized at completion.

## Presigned URL

Time-limited signed URL allowing direct upload/download operation without exposing server credentials.

## Resume Session

Backend-tracked state for continuing an interrupted multipart upload.

## Session Storage

Browser storage scoped to the current tab/window session. MediVault uses this for auth token persistence.

## Upload Session

Operational record in MongoDB tracking upload_id, file_key, completed parts, bucket context, and lifecycle status.

## Upload History Record

Completed upload metadata record in MongoDB used for dashboard and history screens.

## USE_MOCK_S3

Backend mode that emulates S3 behavior for local validation without calling real AWS services.
