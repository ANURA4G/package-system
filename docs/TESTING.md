# Testing

## 1. Testing Scope

Current testing is primarily:

- Manual functional verification via UI
- API smoke checks
- Optional mock-mode checks for backend flows

## 2. Frontend Validation

From frontend directory:

```powershell
npm run lint
npm run build
```

Manual checks:

1. Login and logout flow.
2. Bucket add/edit/delete flow with validation messaging.
3. Upload flow: prepare, start, pause, resume, cancel, complete.
4. History filtering and sorting.
5. Dashboard bucket usage and status rendering.

## 3. Backend Validation

From backend directory:

```powershell
python -m pip install -r requirements.txt
uvicorn app.main:app --reload
```

Smoke checks:

- GET /health returns healthy response.
- Auth register/login/me endpoints return expected statuses.
- Upload lifecycle endpoints enforce auth and bucket checks.

## 4. Optional Mock-Mode Checks

If a developer wants to validate mock storage behavior locally, they can enable mock mode in environment settings and run targeted API or UI smoke tests.

Notes:

- Mock-mode artifacts are intentionally not stored in this cleaned repository.
- Teams that need mock-mode test scripts can maintain them locally or in a separate testing branch.

## 5. Suggested Regression Matrix

### Authentication

- Invalid credentials -> 401
- Expired/invalid token -> 401 on protected routes
- Session storage behavior: refresh keeps session, tab close clears session

### Bucket Management

- Add valid bucket -> saved
- Add bucket with auth/access/not-found issue -> pending manual validation path
- Edit bucket metadata and KMS rules
- Delete blocked when upload is in progress

### Upload Lifecycle

- Start with no bucket selected -> blocked by UI
- Resume only with matching bucket
- Presign/complete/abort reject bucket mismatch
- Retry behavior on transient part failures

## 6. Pre-Release Checklist

- Frontend build succeeds.
- Backend starts cleanly and health check passes.
- No diagnostics errors in modified files.
- Documentation updated for behavior changes.
