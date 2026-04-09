from slowapi import Limiter
from slowapi.util import get_remote_address

# IP-based rate limiting for public API endpoints.
limiter = Limiter(key_func=get_remote_address)
