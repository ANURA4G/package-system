from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel
from app.database import users_collection
from app.auth import get_password_hash, verify_password, create_access_token, get_current_user
from app.rate_limit import limiter

router = APIRouter(prefix="/auth", tags=["Auth"])

class UserCredentials(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str

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
async def login(request: Request, user: UserCredentials):
    db_user = users_collection.find_one({"username": user.username})
    if not db_user or not verify_password(user.password, db_user["password"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    
    token = create_access_token(data={"sub": user.username})
    return {"access_token": token, "token_type": "bearer"}

@router.get("/me")
async def get_me(username: str = Depends(get_current_user)):
    return {"username": username}
