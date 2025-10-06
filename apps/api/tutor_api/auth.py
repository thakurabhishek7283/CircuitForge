"""Anonymous sessions until Phase 4 auth (LLD §14): `POST /v1/auth/anonymous` creates a user and
returns a signed token (HS256 JWT, `sub` = user id). Every other route needs
`Authorization: Bearer <token>`."""

from __future__ import annotations

import time
import uuid
from typing import Annotated

import jwt
from fastapi import Depends, Request

from .errors import ApiException

ALGORITHM = "HS256"
KIND = "anon"


def issue(secret: str, user_id: uuid.UUID, ttl_s: int) -> str:
    now = int(time.time())
    return jwt.encode({"sub": str(user_id), "typ": KIND, "iat": now, "exp": now + ttl_s}, secret, algorithm=ALGORITHM)


def verify(secret: str, token: str) -> uuid.UUID:
    try:
        claims = jwt.decode(token, secret, algorithms=[ALGORITHM], options={"require": ["sub", "exp"]})
        if claims.get("typ") != KIND:
            raise jwt.InvalidTokenError("wrong token type")
        return uuid.UUID(claims["sub"])
    except (jwt.InvalidTokenError, ValueError) as e:
        raise ApiException(401, "unauthorized", f"invalid token: {e}") from None


def current_user(request: Request) -> uuid.UUID:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise ApiException(401, "unauthorized", "missing bearer token")
    return verify(request.app.state.settings.auth_secret, token.strip())


User = Annotated[uuid.UUID, Depends(current_user)]
