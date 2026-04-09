import asyncio

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from app.routes import router
from app.auth_routes import router as auth_router
from app.config import get_settings
from app.rate_limit import limiter
from app.database import check_database_connection
from app.cleanup import cleanup_expired_upload_sessions_once, run_expired_upload_cleanup_loop

settings = get_settings()

app = FastAPI(
    title="Medical File Upload API",
    description="Resilient multipart upload system for large medical files",
    version="1.0.0",
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# CORS — allow the React dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/api")
app.include_router(router, prefix="/api")


@app.on_event("startup")
async def startup_event():
    check_database_connection()
    cleanup_expired_upload_sessions_once()
    app.state.cleanup_task = asyncio.create_task(
        run_expired_upload_cleanup_loop(settings.UPLOAD_CLEANUP_INTERVAL_SECONDS)
    )


@app.on_event("shutdown")
async def shutdown_event():
    task = getattr(app.state, "cleanup_task", None)
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "medical-upload-api"}
