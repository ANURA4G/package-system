# MediVault Frontend

React + Vite client for authenticated, resumable medical file uploads.

## Current Demo Scope

- Login and registration flow.
- Multipart chunk upload to S3 through backend pre-signed URLs.
- Pause, resume, cancel, retry, and upload history.
- Local file preview (image/pdf/dicom/excel/generic) before or during upload.

## Future Scope

- Cloud DICOM preview (thumbnail/slice from S3 after upload).
- AI/ML-driven upload analytics and anomaly detection UI.
- Advanced compliance dashboards and operational telemetry views.

## Prerequisites

- Node.js 18+.
- npm 9+.
- Backend API running on http://127.0.0.1:8000 for local development.

## Environment Variables

Create frontend/.env if you need to override API base paths.

- VITE_API_AUTH_BASE (default: /api/auth)
- VITE_API_UPLOAD_BASE (default: /api/upload)

Local development usually needs no .env because Vite proxy forwards /api to backend.

## Local Development

1. Install dependencies:

	npm install

2. Start the frontend dev server:

	npm run dev

3. Open the printed local URL (default http://localhost:5173).

## Build and Preview

1. Build production assets:

	npm run build

2. Preview production build locally:

	npm run preview

## UX and Error Handling Notes

- Toast notifications appear for chunk failure after max retries.
- Toast notifications appear for auth/session errors (expired or invalid token).
- Upload status panel keeps detailed error text for troubleshooting.

## Preview Behavior

- Preview modal is local-browser preview only (object URL).
- It does not fetch uploaded content from S3.
- DICOM cloud preview is currently out of demo scope and tracked as future work.
