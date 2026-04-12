# Contributing To MediVault

Thank you for contributing.

## Development Principles

- Keep upload correctness and data safety as top priority.
- Do not introduce breaking API changes without updating docs/API.md.
- Prefer explicit validation over silent fallback behavior.
- Keep security-sensitive changes reviewed by at least one peer.

## Local Setup

1. Start MongoDB:
   - `docker compose up -d mongo`
2. Backend:
   - `cd backend`
   - `pip install -r requirements.txt`
   - `uvicorn app.main:app --reload`
3. Frontend:
   - `cd frontend`
   - `npm install`
   - `npm run dev`

## Branch And Commit Guidelines

- Branch naming:
  - `feature/<short-name>`
  - `fix/<short-name>`
  - `docs/<short-name>`
- Commit style:
  - Use clear intent-first messages.
  - Example: `fix(upload): enforce bucket-session consistency on resume`

## Pull Request Checklist

- [ ] Change is scoped and minimal.
- [ ] No unrelated formatting churn.
- [ ] API docs updated when endpoints/contracts changed.
- [ ] Security impact reviewed for auth, bucket, or crypto changes.
- [ ] Manual smoke test completed for upload start/resume/complete/abort paths.
- [ ] Frontend build passes.

## Code Style

### Backend (Python/FastAPI)

- Keep route handlers explicit and defensive.
- Raise FastAPI HTTPException with precise status and detail.
- Log operational events without leaking secrets.

### Frontend (React)

- Keep auth and upload state transitions predictable.
- Preserve bucket requirement checks in UI actions.
- Keep user-facing errors actionable.

## Documentation Expectations

Any change to upload flow, auth behavior, bucket logic, or security controls must update at least one of:

- docs/ARCHITECTURE.md
- docs/API.md
- docs/SECURITY.md
- docs/TROUBLESHOOTING.md

## Reporting Issues

Include:

- Exact action sequence
- Relevant API path
- Browser/network conditions
- Backend response status/detail
- Minimal reproduction steps
