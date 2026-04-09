import os
import random
from pathlib import Path

# Force mock storage mode so no real AWS calls are made.
os.environ["USE_MOCK_S3"] = "true"
os.environ.setdefault("MOCK_S3_PART_FAILURE_RATE", "0")
os.environ.setdefault("UPLOAD_CLEANUP_INTERVAL_SECONDS", "3600")

from fastapi.testclient import TestClient

from app.main import app
from app.database import users_collection, upload_sessions_collection, uploads_collection
from app import mock_s3_service
from app.config import get_settings

CHUNK_SIZE = 5 * 1024 * 1024


class ValidationFailure(Exception):
    pass


def assert_true(condition, message):
    if not condition:
        raise ValidationFailure(message)


def make_auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def build_file_id(file_name: str, size: int) -> str:
    return f"{file_name}-{size}"


def split_bytes(data: bytes, chunk_size: int = CHUNK_SIZE):
    chunks = []
    start = 0
    part_number = 1
    while start < len(data):
        end = min(start + chunk_size, len(data))
        chunks.append((part_number, data[start:end]))
        part_number += 1
        start = end
    return chunks


def build_virtual_file(total_parts: int, tag: str):
    assert_true(total_parts >= 1, "total_parts must be >= 1")
    virtual_size = (total_parts - 1) * CHUNK_SIZE + 1
    chunks = [(pn, f"{tag}-part-{pn}".encode("utf-8")) for pn in range(1, total_parts + 1)]
    return virtual_size, chunks


def register_and_login(client: TestClient, username: str, password: str) -> str:
    register_resp = client.post("/api/auth/register", json={"username": username, "password": password})
    assert_true(register_resp.status_code in (200, 400), f"Unexpected register status {register_resp.status_code}")

    login_resp = client.post("/api/auth/login", json={"username": username, "password": password})
    assert_true(login_resp.status_code == 200, f"Login failed: {login_resp.status_code} {login_resp.text}")
    token = login_resp.json().get("access_token")
    assert_true(bool(token), "Missing access token")
    return token


def start_upload(client: TestClient, headers: dict, file_id: str, file_name: str, size: int):
    resp = client.post(
        "/api/upload/start-upload",
        headers=headers,
        json={
            "file_id": file_id,
            "file_name": file_name,
            "content_type": "application/octet-stream",
            "size": size,
        },
    )
    assert_true(resp.status_code == 200, f"start-upload failed: {resp.status_code} {resp.text}")
    return resp.json()


def get_presigned_url(client: TestClient, headers: dict, file_key: str, upload_id: str, part_number: int) -> str:
    resp = client.post(
        "/api/upload/presigned-url",
        headers=headers,
        json={
            "file_key": file_key,
            "upload_id": upload_id,
            "part_number": part_number,
        },
    )
    assert_true(resp.status_code == 200, f"presigned-url failed: {resp.status_code} {resp.text}")
    url = resp.json().get("url")
    assert_true(bool(url), "Missing pre-signed URL")
    assert_true(url.startswith("/api/upload/mock-upload-part"), "Expected mock upload URL in mock mode")
    return url


def upload_part_once(
    client: TestClient,
    headers: dict,
    file_id: str,
    file_key: str,
    upload_id: str,
    part_number: int,
    chunk: bytes,
) -> str:
    url = get_presigned_url(client, headers, file_key, upload_id, part_number)
    put_resp = client.put(url, content=chunk)
    assert_true(put_resp.status_code == 200, f"mock PUT failed: {put_resp.status_code} {put_resp.text}")

    etag = put_resp.headers.get("ETag") or put_resp.headers.get("etag")
    assert_true(bool(etag), "Missing ETag from mock PUT")

    update_resp = client.post(
        "/api/upload/update-part",
        headers=headers,
        json={
            "file_id": file_id,
            "file_key": file_key,
            "upload_id": upload_id,
            "part_number": part_number,
            "etag": etag,
        },
    )
    assert_true(update_resp.status_code == 200, f"update-part failed: {update_resp.status_code} {update_resp.text}")

    return etag


def upload_parts_with_retry(
    client: TestClient,
    headers: dict,
    file_id: str,
    file_key: str,
    upload_id: str,
    chunks,
    target_part_numbers,
    max_retries: int = 3,
    fail_once_parts=None,
):
    fail_once_parts = fail_once_parts or set()
    uploaded = []
    retries_used = 0

    chunk_map = {part_number: chunk for part_number, chunk in chunks}

    for part_number in target_part_numbers:
        attempts = 0
        while attempts < max_retries:
            attempts += 1
            try:
                if attempts == 1 and part_number in fail_once_parts:
                    raise RuntimeError("Simulated transient client/network failure")
                etag = upload_part_once(
                    client,
                    headers,
                    file_id,
                    file_key,
                    upload_id,
                    part_number,
                    chunk_map[part_number],
                )
                uploaded.append({"PartNumber": part_number, "ETag": etag})
                break
            except Exception:
                if attempts >= max_retries:
                    raise
                retries_used += 1

    return uploaded, retries_used


def resume_session(client: TestClient, headers: dict, file_id: str):
    resp = client.get(f"/api/upload/resume-session?file_id={file_id}", headers=headers)
    assert_true(resp.status_code == 200, f"resume-session failed: {resp.status_code} {resp.text}")
    data = resp.json()
    if data.get("has_session") is False:
        return None
    return data


def complete_upload(client: TestClient, headers: dict, file_id: str, file_key: str, upload_id: str, file_name: str, size: int, parts):
    resp = client.post(
        "/api/upload/complete-upload",
        headers=headers,
        json={
            "file_id": file_id,
            "file_key": file_key,
            "upload_id": upload_id,
            "file_name": file_name,
            "size": size,
            "parts": parts,
        },
    )
    return resp


def abort_upload(client: TestClient, headers: dict, file_key: str, upload_id: str):
    resp = client.post(
        "/api/upload/abort",
        headers=headers,
        json={"file_key": file_key, "upload_id": upload_id},
    )
    return resp


def check_frontend_logic_signals(repo_root: Path):
    app_text = (repo_root / "frontend/src/App.jsx").read_text(encoding="utf-8")
    hook_text = (repo_root / "frontend/src/hooks/useChunkedUpload.js").read_text(encoding="utf-8")

    assert_true("await prepareUpload(selectedFile);" in app_text, "Frontend auto-resume precheck is missing")
    assert_true("if (file) upload(file);" in app_text, "Frontend explicit start upload trigger is missing")
    assert_true("if (completedSet.has(chunk.partNumber))" in hook_text, "Uploaded-part skip guard is missing")
    assert_true("activeUploadRef.current" in hook_text, "Duplicate-upload guard is missing")
    assert_true("normalizeUploadError" in hook_text, "Frontend error normalization is missing")


def run_validation():
    settings = get_settings()
    assert_true(settings.USE_MOCK_S3 is True, "USE_MOCK_S3 must be true for this validation")

    # Isolate test state
    mock_s3_service.reset_state()
    users_collection.delete_many({})
    upload_sessions_collection.delete_many({})
    uploads_collection.delete_many({})

    username = "mock-e2e-user"
    password = "mock-e2e-password"

    issues = []

    with TestClient(app) as client:
        token = register_and_login(client, username, password)
        headers = make_auth_headers(token)

        # 1) Normal upload + incomplete validation + idempotent update-part
        file_name_1 = "normal_case.bin"
        size_1, chunks_1 = build_virtual_file(3, "normal")
        file_id_1 = build_file_id(file_name_1, size_1)
        start_1 = start_upload(client, headers, file_id_1, file_name_1, size_1)
        upload_id_1 = start_1["upload_id"]
        file_key_1 = start_1["file_key"]

        # Upload first two parts
        uploaded_1a, _ = upload_parts_with_retry(
            client,
            headers,
            file_id_1,
            file_key_1,
            upload_id_1,
            chunks_1,
            target_part_numbers=[1, 2],
        )

        # Idempotency check: repeat part 1 update using same ETag
        idem_resp = client.post(
            "/api/upload/update-part",
            headers=headers,
            json={
                "file_id": file_id_1,
                "file_key": file_key_1,
                "upload_id": upload_id_1,
                "part_number": 1,
                "etag": uploaded_1a[0]["ETag"],
            },
        )
        assert_true(idem_resp.status_code == 200, "Idempotent update-part should not fail")

        incomplete_resp = complete_upload(
            client,
            headers,
            file_id_1,
            file_key_1,
            upload_id_1,
            file_name_1,
            size_1,
            uploaded_1a,
        )
        assert_true(incomplete_resp.status_code == 400, "complete-upload should fail for incomplete uploads")

        uploaded_1b, _ = upload_parts_with_retry(
            client,
            headers,
            file_id_1,
            file_key_1,
            upload_id_1,
            chunks_1,
            target_part_numbers=[3],
        )

        complete_resp_1 = complete_upload(
            client,
            headers,
            file_id_1,
            file_key_1,
            upload_id_1,
            file_name_1,
            size_1,
            uploaded_1a + uploaded_1b,
        )
        assert_true(complete_resp_1.status_code == 200, f"Normal complete failed: {complete_resp_1.status_code}")

        session_1 = upload_sessions_collection.find_one({"upload_id": upload_id_1, "user_id": username})
        assert_true(session_1 is not None and session_1.get("status") == "completed", "Normal upload session not completed")
        assert_true(len(set(session_1.get("uploaded_part_numbers", []))) == 3, "Part numbers were not tracked correctly")

        # 2) Pause + Resume
        file_name_2 = "pause_resume.bin"
        size_2, chunks_2 = build_virtual_file(4, "pause")
        file_id_2 = build_file_id(file_name_2, size_2)
        start_2 = start_upload(client, headers, file_id_2, file_name_2, size_2)
        upload_id_2 = start_2["upload_id"]
        file_key_2 = start_2["file_key"]

        upload_parts_with_retry(
            client,
            headers,
            file_id_2,
            file_key_2,
            upload_id_2,
            chunks_2,
            target_part_numbers=[1, 2],
        )

        resume_2 = resume_session(client, headers, file_id_2)
        assert_true(resume_2 is not None, "Pause/resume session should exist")
        uploaded_2 = set(resume_2["uploaded_part_numbers"])
        assert_true(uploaded_2 == {1, 2}, f"Unexpected uploaded parts on resume: {uploaded_2}")

        remaining_2 = [pn for pn, _ in chunks_2 if pn not in uploaded_2]
        uploaded_2b, _ = upload_parts_with_retry(
            client,
            headers,
            file_id_2,
            file_key_2,
            upload_id_2,
            chunks_2,
            target_part_numbers=remaining_2,
        )
        assert_true(len(uploaded_2b) == len(remaining_2), "Resume phase uploaded unexpected part count")

        complete_resp_2 = complete_upload(
            client,
            headers,
            file_id_2,
            file_key_2,
            upload_id_2,
            file_name_2,
            size_2,
            uploaded_2b,
        )
        assert_true(complete_resp_2.status_code == 200, "Pause/resume completion failed")

        # 3) Crash recovery simulation
        file_name_3 = "crash_recovery.bin"
        size_3, chunks_3 = build_virtual_file(7, "crash")
        file_id_3 = build_file_id(file_name_3, size_3)
        start_3 = start_upload(client, headers, file_id_3, file_name_3, size_3)
        upload_id_3 = start_3["upload_id"]
        file_key_3 = start_3["file_key"]

        upload_parts_with_retry(
            client,
            headers,
            file_id_3,
            file_key_3,
            upload_id_3,
            chunks_3,
            target_part_numbers=[1, 2, 3, 4, 5],
        )

    # Simulated backend restart: create a new TestClient instance
    with TestClient(app) as client_after_restart:
        token_2 = register_and_login(client_after_restart, username, password)
        headers_2 = make_auth_headers(token_2)

        resume_3 = resume_session(client_after_restart, headers_2, file_id_3)
        assert_true(resume_3 is not None, "Crash recovery resume session missing after restart")
        assert_true(set(resume_3["uploaded_part_numbers"]) == {1, 2, 3, 4, 5}, "Crash recovery returned wrong uploaded parts")

        remaining_3 = [pn for pn, _ in chunks_3 if pn not in set(resume_3["uploaded_part_numbers"])]
        uploaded_3b, _ = upload_parts_with_retry(
            client_after_restart,
            headers_2,
            file_id_3,
            file_key_3,
            upload_id_3,
            chunks_3,
            target_part_numbers=remaining_3,
        )

        complete_resp_3 = complete_upload(
            client_after_restart,
            headers_2,
            file_id_3,
            file_key_3,
            upload_id_3,
            file_name_3,
            size_3,
            uploaded_3b,
        )
        assert_true(complete_resp_3.status_code == 200, "Crash recovery completion failed")

        # 4) Retry logic with random fail-once parts
        file_name_4 = "retry_logic.bin"
        size_4, chunks_4 = build_virtual_file(5, "retry")
        file_id_4 = build_file_id(file_name_4, size_4)
        start_4 = start_upload(client_after_restart, headers_2, file_id_4, file_name_4, size_4)
        upload_id_4 = start_4["upload_id"]
        file_key_4 = start_4["file_key"]

        random.seed(42)
        fail_once_parts = {pn for pn, _ in chunks_4 if random.random() < 0.5}
        if not fail_once_parts:
            fail_once_parts = {1}

        uploaded_4, retries_used = upload_parts_with_retry(
            client_after_restart,
            headers_2,
            file_id_4,
            file_key_4,
            upload_id_4,
            chunks_4,
            target_part_numbers=[pn for pn, _ in chunks_4],
            max_retries=5,
            fail_once_parts=fail_once_parts,
        )
        assert_true(retries_used > 0, "Retry scenario did not exercise retries")

        complete_resp_4 = complete_upload(
            client_after_restart,
            headers_2,
            file_id_4,
            file_key_4,
            upload_id_4,
            file_name_4,
            size_4,
            uploaded_4,
        )
        assert_true(complete_resp_4.status_code == 200, "Retry scenario completion failed")

        # 5) Cancel flow
        file_name_5 = "cancel_flow.bin"
        size_5, chunks_5 = build_virtual_file(4, "cancel")
        file_id_5 = build_file_id(file_name_5, size_5)
        start_5 = start_upload(client_after_restart, headers_2, file_id_5, file_name_5, size_5)
        upload_id_5 = start_5["upload_id"]
        file_key_5 = start_5["file_key"]

        upload_parts_with_retry(
            client_after_restart,
            headers_2,
            file_id_5,
            file_key_5,
            upload_id_5,
            chunks_5,
            target_part_numbers=[1, 2],
        )

        abort_resp = abort_upload(client_after_restart, headers_2, file_key_5, upload_id_5)
        assert_true(abort_resp.status_code == 200, f"Abort failed: {abort_resp.status_code}")

        cancelled_session = upload_sessions_collection.find_one({"upload_id": upload_id_5, "user_id": username})
        assert_true(cancelled_session and cancelled_session.get("status") == "cancelled", "Cancel flow did not mark session cancelled")
        assert_true(mock_s3_service.get_upload(upload_id_5) is None, "Mock storage still has aborted upload")

    # Frontend behavior validation via source checks.
    repo_root = Path(__file__).resolve().parents[1]
    check_frontend_logic_signals(repo_root)

    return {
        "status": "ok",
        "issues": issues,
        "summary": {
            "normal_upload": "passed",
            "pause_resume": "passed",
            "crash_recovery": "passed",
            "retry_logic": "passed",
            "cancel_flow": "passed",
            "backend_validations": "passed",
            "frontend_validations": "passed",
        },
    }


if __name__ == "__main__":
    try:
        result = run_validation()
        print("MOCK_E2E_RESULT=PASS")
        print(result)
    except Exception as e:
        print("MOCK_E2E_RESULT=FAIL")
        print(str(e))
        raise
