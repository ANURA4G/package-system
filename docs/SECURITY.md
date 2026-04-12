# Security

## 1. Security Goals

- Protect medical file upload workflows against unauthorized access.
- Prevent accidental cross-bucket upload operations.
- Keep cloud bucket credentials confidential at rest.
- Minimize abuse through endpoint throttling and strict validation.

## 2. Implemented Controls

### Authentication And Session

- Password hashing with bcrypt before persistence.
- JWT access token required for protected APIs.
- Token expiration enforced by backend.
- Frontend stores token in session storage (tab/window close clears session).

### Authorization Scope

- Upload and bucket operations are scoped by authenticated user_id.
- Bucket records are queried per user before upload actions.
- System-default bucket cannot be edited or deleted through bucket management routes.

### Credential Protection

- AWS access key and secret key are encrypted using Fernet before storing in MongoDB.
- Decryption occurs only when constructing S3 client context server-side.
- Secrets are not exposed in API responses.

### Input Validation

- Backend validates bucket naming and region format/validity.
- KMS logic enforces kms_key_id when use_kms is enabled.
- Upload extension allowlist enforced server-side.
- Frontend validates file magic bytes before upload starts.

### Abuse Prevention

- Rate limits on auth and upload endpoints via SlowAPI.
- Idempotent part-update behavior reduces race impact and duplicate writes.

### Operational Safety

- Expired upload sessions are cleaned up in background.
- Cleanup handles NoSuchUpload and retry scenarios safely.

## 3. Threats And Mitigations

| Threat | Mitigation In Place |
|---|---|
| Brute-force login attempts | Route-level rate limiting on auth endpoints |
| Token replay after browser close | Session-scoped storage instead of local persistent storage |
| Bucket credential leakage from DB | Encryption at rest with Fernet |
| Uploading into wrong bucket | Bucket-session consistency checks on resume/presign/complete/abort |
| Unsupported file uploads | Frontend magic-byte validation + backend extension allowlist |
| Stale unfinished multipart sessions | Background cleanup loop with status transitions |

## 4. Security Operational Checklist

- Rotate JWT secret periodically.
- Rotate ENCRYPTION_KEY with migration plan if required.
- Use HTTPS/TLS in all non-local environments.
- Restrict CORS origins to approved domains.
- Ensure MongoDB is private-network only in production.
- Use least-privilege IAM for bucket credentials.

## 5. Recommended Next Hardening Steps

- Add refresh-token strategy with revocation support.
- Add role-based access control for admin/operator separation.
- Add centralized audit logs for auth and bucket changes.
- Add malware scanning pipeline before or after object ingestion.
- Add object-level SSE policy enforcement verification.

## 6. Incident Response Basics

If compromise is suspected:

1. Revoke affected AWS credentials.
2. Rotate JWT secret and force re-authentication.
3. Rotate ENCRYPTION_KEY using a controlled re-encryption plan.
4. Inspect recent bucket updates and upload history for anomalies.
5. Revalidate all active bucket configurations.
