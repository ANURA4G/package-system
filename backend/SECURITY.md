# Backend Security Notes

## JWT Secret Requirements

- `JWT_SECRET_KEY` must be provided via environment variables or `.env`.
- It must be at least 32 characters and should be a cryptographically random value.
- Weak defaults such as `supersecretkey`, `default_secret`, `changeme`, `secret`, and `password` are rejected.

## Access Token Lifetime

- `ACCESS_TOKEN_EXPIRE_MINUTES` is constrained to 60-1440 minutes (1-24 hours).
- Current default is 60 minutes.

## Refresh Token Flow

- A refresh token endpoint is not enabled by default.
- For short sessions (1 hour), users re-authenticate when access tokens expire.
- If long-lived sessions are required, add a dedicated refresh token flow (`/auth/refresh`) with token rotation and revocation tracking.

## CORS Configuration

- Allowed origins are configured through `CORS_ALLOW_ORIGINS`.
- Use a comma-separated list, for example:
  - `CORS_ALLOW_ORIGINS=https://app.your-domain.com`
  - `CORS_ALLOW_ORIGINS=https://app.your-domain.com,https://admin.your-domain.com`

## Optional Hardening

- Rate limiting is enabled with `slowapi` using IP-based limits.
- Current limits:
  - `/api/auth/register`: 5/minute
  - `/api/auth/login`: 10/minute
  - `/api/upload/start-upload`: 30/minute
  - `/api/upload/presigned-url`: 600/minute
  - `/api/upload/update-part`: 600/minute
  - `/api/upload/complete-upload`: 30/minute
  - `/api/upload/abort`: 60/minute
- Add account lockout or progressive backoff for repeated failed login attempts.
- Rotate JWT secrets periodically and on incident response.
- Configure an S3 lifecycle rule to abort incomplete multipart uploads after 1-2 days as a cleanup safety net.
