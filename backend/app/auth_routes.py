from fastapi import APIRouter, HTTPException, Depends, Request, Response
import hashlib
import logging
from datetime import datetime, timedelta
from pydantic import BaseModel
from app.database import users_collection, refresh_tokens_collection
from app.auth import get_password_hash, verify_password, create_access_token, create_refresh_token, decode_refresh_token, get_current_user
from app.config import get_settings
from app.rate_limit import limiter

settings = get_settings()
logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["Auth"])

REFRESH_COOKIE_NAME = "refresh_token"
REFRESH_COOKIE_MAX_AGE = settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60

class UserCredentials(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    expires_in: int

@router.post("/register")
@limiter.limit("5/minute")
async def register(request: Request, user: UserCredentials):
    # Check if user exists
    existing = users_collection.find_one({"username": user.username})
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    
    # Create user
    hashed_password = get_password_hash(user.password)
    users_collection.insert_one({
        "username": user.username,
        "password": hashed_password
    })
    return {"message": "User registered successfully"}

@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
async def login(request: Request, response: Response, user: UserCredentials):
    db_user = users_collection.find_one({"username": user.username})
    if not db_user or not verify_password(user.password, db_user["password"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    access_token = create_access_token(data={"sub": user.username})
    refresh_token = create_refresh_token(data={"sub": user.username})

    # Store hashed refresh token in DB for rotation/revocation
    token_hash = hashlib.sha256(refresh_token.encode()).hexdigest()
    expires_at = datetime.utcnow() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    refresh_tokens_collection.insert_one({
        "token_hash": token_hash,
        "username": user.username,
        "expires_at": expires_at,
        "created_at": datetime.utcnow(),
    })

    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=refresh_token,
        httponly=True,
        secure=True,
        samesite="strict",
        max_age=REFRESH_COOKIE_MAX_AGE,
        path="/api/auth",
    )

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }

@router.post("/refresh", response_model=TokenResponse)
@limiter.limit("30/minute")
async def refresh(request: Request, response: Response):
    refresh_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Refresh token missing")

    payload = decode_refresh_token(refresh_token)
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=401, detail="Invalid refresh token payload")

    # Verify token is in DB (not revoked)
    token_hash = hashlib.sha256(refresh_token.encode()).hexdigest()
    stored = refresh_tokens_collection.find_one({"token_hash": token_hash})
    if not stored:
        logger.warning("Refresh token reuse or revoked token attempt username=%s", username)
        raise HTTPException(status_code=401, detail="Refresh token has been revoked")

    # Rotate: delete old token, issue new refresh token
    refresh_tokens_collection.delete_one({"token_hash": token_hash})

    new_access_token = create_access_token(data={"sub": username})
    new_refresh_token = create_refresh_token(data={"sub": username})

    new_token_hash = hashlib.sha256(new_refresh_token.encode()).hexdigest()
    expires_at = datetime.utcnow() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    refresh_tokens_collection.insert_one({
        "token_hash": new_token_hash,
        "username": username,
        "expires_at": expires_at,
        "created_at": datetime.utcnow(),
    })

    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=new_refresh_token,
        httponly=True,
        secure=True,
        samesite="strict",
        max_age=REFRESH_COOKIE_MAX_AGE,
        path="/api/auth",
    )

    return {
        "access_token": new_access_token,
        "token_type": "bearer",
        "expires_in": settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    }

@router.post("/logout")
async def logout(request: Request, response: Response):
    refresh_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if refresh_token:
        token_hash = hashlib.sha256(refresh_token.encode()).hexdigest()
        refresh_tokens_collection.delete_one({"token_hash": token_hash})

    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path="/api/auth",
        httponly=True,
        secure=True,
        samesite="strict",
    )
    return {"message": "Logged out successfully"}

@router.get("/me")
async def get_me(username: str = Depends(get_current_user)):
    return {"username": username}
