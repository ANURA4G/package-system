#!/usr/bin/env python3
"""Seed demo users and upload history records for local demos."""

from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

# Allow running this script from backend/ without additional PYTHONPATH setup.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.auth import get_password_hash  # noqa: E402
from app.database import uploads_collection, users_collection  # noqa: E402

SEED_TAG = "demo_polish_v1"
DEFAULT_PASSWORD = "DemoPass123!"
DEMO_USERS = [
    {"username": "doctor.demo", "role": "doctor", "full_name": "Dr. Maya Carter"},
    {"username": "patient.demo", "role": "patient", "full_name": "Alex Reed"},
]


def _checksum_for(name: str) -> str:
    return hashlib.sha256(name.encode("utf-8")).hexdigest()


def _demo_upload_records(now: datetime) -> list[dict]:
    return [
        {
            "user_id": "doctor.demo",
            "filename": "ct-scan-series-001.zip",
            "size": 184_549_376,
            "checksum": _checksum_for("ct-scan-series-001.zip"),
            "expected_size": 184_549_376,
            "actual_size": 184_549_376,
            "size_mismatch": False,
            "bucket": "radiology-secure-bucket",
            "file_id": "ct-scan-series-001.zip-184549376",
            "file_key": "uploads/doctor.demo/ct-scan-series-001.zip",
            "status": "completed",
            "created_at": (now - timedelta(hours=3)).isoformat(),
            "seed_tag": SEED_TAG,
        },
        {
            "user_id": "doctor.demo",
            "filename": "knee-mri-report.pdf",
            "size": 2_408_112,
            "checksum": _checksum_for("knee-mri-report.pdf"),
            "expected_size": 2_408_112,
            "actual_size": 2_408_112,
            "size_mismatch": False,
            "bucket": "radiology-secure-bucket",
            "file_id": "knee-mri-report.pdf-2408112",
            "file_key": "uploads/doctor.demo/knee-mri-report.pdf",
            "status": "completed",
            "created_at": (now - timedelta(hours=1, minutes=25)).isoformat(),
            "seed_tag": SEED_TAG,
        },
        {
            "user_id": "patient.demo",
            "filename": "lab-results-apr-2026.pdf",
            "size": 912_440,
            "checksum": _checksum_for("lab-results-apr-2026.pdf"),
            "expected_size": 912_440,
            "actual_size": 912_440,
            "size_mismatch": False,
            "bucket": "patient-portal-bucket",
            "file_id": "lab-results-apr-2026.pdf-912440",
            "file_key": "uploads/patient.demo/lab-results-apr-2026.pdf",
            "status": "completed",
            "created_at": (now - timedelta(minutes=35)).isoformat(),
            "seed_tag": SEED_TAG,
        },
    ]


def seed_users(password: str) -> tuple[int, int]:
    created = 0
    updated = 0

    for user in DEMO_USERS:
        existing = users_collection.find_one({"username": user["username"]})
        payload = {
            "username": user["username"],
            "password": get_password_hash(password),
            "role": user["role"],
            "full_name": user["full_name"],
            "seed_tag": SEED_TAG,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

        if existing:
            users_collection.update_one(
                {"username": user["username"]},
                {"$set": payload},
            )
            updated += 1
        else:
            payload["created_at"] = datetime.now(timezone.utc).isoformat()
            users_collection.insert_one(payload)
            created += 1

    return created, updated


def seed_uploads() -> int:
    now = datetime.now(timezone.utc)
    records = _demo_upload_records(now)

    uploads_collection.delete_many({"seed_tag": SEED_TAG})
    if records:
        uploads_collection.insert_many(records)
    return len(records)


def reset_seed_data() -> tuple[int, int]:
    user_names = [user["username"] for user in DEMO_USERS]
    users_result = users_collection.delete_many({"username": {"$in": user_names}, "seed_tag": SEED_TAG})
    uploads_result = uploads_collection.delete_many({"seed_tag": SEED_TAG})
    return users_result.deleted_count, uploads_result.deleted_count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed MediVault demo users and uploads.")
    parser.add_argument(
        "--password",
        default=DEFAULT_PASSWORD,
        help="Password to assign to all seeded demo users.",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Remove previously seeded demo users and uploads before seeding.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.reset:
        deleted_users, deleted_uploads = reset_seed_data()
        print(f"[seed] reset: removed {deleted_users} users and {deleted_uploads} uploads")

    created_users, updated_users = seed_users(args.password)
    seeded_uploads = seed_uploads()

    print("[seed] complete")
    print(f"[seed] users created: {created_users}")
    print(f"[seed] users updated: {updated_users}")
    print(f"[seed] uploads inserted: {seeded_uploads}")
    print("[seed] login users:")
    print(f"  - doctor.demo / {args.password}")
    print(f"  - patient.demo / {args.password}")


if __name__ == "__main__":
    main()
