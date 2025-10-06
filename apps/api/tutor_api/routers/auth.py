from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Request
from sqlalchemy import insert

from .. import auth
from ..db.tables import users
from ..models.contract import AnonymousSession

router = APIRouter(prefix="/v1/auth", tags=["auth"])


@router.post("/anonymous", status_code=201)
async def anonymous(request: Request) -> AnonymousSession:
    """A new anonymous user and its token (until Phase 4 auth; quotas per IP come with it)."""
    st = request.app.state
    user_id = uuid.uuid4()
    async with st.engine.begin() as conn:
        await conn.execute(insert(users).values(id=user_id, created_at=datetime.now(UTC)))
    ttl = st.settings.anonymous_token_ttl_s
    return AnonymousSession(token=auth.issue(st.settings.auth_secret, user_id, ttl), user_id=str(user_id), expires_in=ttl)
